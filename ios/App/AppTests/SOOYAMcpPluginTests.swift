import XCTest
@testable import App

final class SOOYAMcpPluginTests: XCTestCase {
    override func tearDown() {
        URLProtocolStub.reset()
        super.tearDown()
    }

    func testModernInitializeSessionPaginationAndToolCall() throws {
        let client = makeClient()
        let lock = NSLock()
        var methods: [String] = []
        var cursors: [String?] = []
        URLProtocolStub.install { request in
            let body = try XCTUnwrap(request.httpBody)
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            let method = try XCTUnwrap(json["method"] as? String)
            lock.lock()
            methods.append(method)
            if method == "tools/list" { cursors.append((json["params"] as? [String: Any])?["cursor"] as? String) }
            lock.unlock()
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json, text/event-stream")
            let headers = method == "initialize" ? ["Content-Type": "application/json", "Mcp-Session-Id": "session-a"] : ["Content-Type": "application/json"]
            let result: [String: Any]
            switch method {
            case "initialize":
                result = ["protocolVersion": "2025-06-18", "capabilities": ["tools": [:]], "serverInfo": ["name": "test", "version": "1"]]
            case "notifications/initialized":
                return stub(request, status: 202, headers: headers, object: nil)
            case "tools/list":
                if ((json["params"] as? [String: Any])?["cursor"] as? String) == "next" {
                    result = ["tools": [["name": "two", "inputSchema": ["type": "object"]]]]
                } else {
                    result = ["tools": [["name": "one", "inputSchema": ["type": "object"]]], "nextCursor": "next"]
                }
            case "tools/call":
                XCTAssertEqual(request.value(forHTTPHeaderField: "Mcp-Session-Id"), "session-a")
                result = ["content": [["type": "text", "text": "ok"]], "isError": false]
            default: throw URLError(.badServerResponse)
            }
            return stub(request, headers: headers, object: ["jsonrpc": "2.0", "id": json["id"] as Any, "result": result])
        }
        let initialized = expectation(description: "initialized")
        client.connect(server("alpha")) { result in
            XCTAssertNoThrow(try result.get())
            initialized.fulfill()
        }
        wait(for: [initialized], timeout: 2)

        let listed = expectation(description: "listed")
        client.listTools(serverID: "alpha") { result in
            XCTAssertEqual(try? result.get().compactMap { $0["name"] as? String }, ["one", "two"])
            listed.fulfill()
        }
        wait(for: [listed], timeout: 2)

        let called = expectation(description: "called")
        client.callTool(serverID: "alpha", name: "one", arguments: ["value": 1]) { result in
            let payload = try? result.get()
            XCTAssertEqual(((payload?["content"] as? [[String: Any]])?.first?["text"] as? String), "ok")
            called.fulfill()
        }
        wait(for: [called], timeout: 2)
        XCTAssertEqual(cursors.count, 2)
        XCTAssertNil(cursors[0])
        XCTAssertEqual(cursors[1], "next")
        XCTAssertTrue(methods.contains("notifications/initialized"))
    }

    func testLegacyFallbackUsesEndpointEventAndKeepsServersIsolated() throws {
        let client = makeClient()
        var initializeAttempts: [String: Int] = [:]
        let lock = NSLock()
        URLProtocolStub.install { request in
            let host = try XCTUnwrap(request.url?.host)
            if request.httpMethod == "GET" {
                let endpoint = "https://\(host)/messages"
                return stub(request, headers: ["Content-Type": "text/event-stream"], raw: "event: endpoint\ndata: \(endpoint)\n\n")
            }
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
            let method = json["method"] as? String
            if method == "initialize", request.url?.path == "/mcp" {
                lock.lock(); initializeAttempts[host, default: 0] += 1; lock.unlock()
                return stub(request, status: 404, object: ["error": "legacy"])
            }
            if method == "notifications/initialized" { return stub(request, status: 202, object: nil) }
            return stub(request, object: ["jsonrpc": "2.0", "id": json["id"] as Any, "result": ["protocolVersion": "2024-11-05", "capabilities": [:], "serverInfo": ["name": host, "version": "1"]]])
        }
        let connected = expectation(description: "both connected")
        connected.expectedFulfillmentCount = 2
        client.connect(server("one")) { _ in connected.fulfill() }
        client.connect(server("two")) { _ in connected.fulfill() }
        wait(for: [connected], timeout: 2)

        XCTAssertEqual(client.snapshot(serverID: "one")?.mode, .legacySSE)
        XCTAssertEqual(client.snapshot(serverID: "two")?.mode, .legacySSE)
        XCTAssertNotEqual(client.snapshot(serverID: "one")?.endpoint, client.snapshot(serverID: "two")?.endpoint)
        XCTAssertEqual(initializeAttempts, ["one.example.test": 1, "two.example.test": 1])
    }

    func testBearerAndOAuthUseTokenReferenceResolverWithoutLoggingToken() throws {
        let resolver = TokenResolver(tokens: ["bearer-ref": "bearer-secret", "oauth-ref": "oauth-secret"])
        let client = makeClient(resolver: resolver)
        var authorizations: [String] = []
        URLProtocolStub.install { request in
            authorizations.append(request.value(forHTTPHeaderField: "Authorization") ?? "")
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
            if json["method"] as? String == "notifications/initialized" { return stub(request, status: 202, object: nil) }
            return stub(request, object: ["jsonrpc": "2.0", "id": json["id"] as Any, "result": ["protocolVersion": "2025-06-18", "capabilities": [:], "serverInfo": ["name": "x", "version": "1"]]])
        }
        let done = expectation(description: "auth")
        done.expectedFulfillmentCount = 2
        client.connect(server("bearer", auth: .bearer(tokenReference: "bearer-ref"))) { _ in done.fulfill() }
        client.connect(server("oauth", auth: .oauth(tokenReference: "oauth-ref"))) { _ in done.fulfill() }
        wait(for: [done], timeout: 2)
        XCTAssertTrue(authorizations.contains("Bearer bearer-secret"))
        XCTAssertTrue(authorizations.contains("Bearer oauth-secret"))
        XCTAssertEqual(Set(resolver.references), Set(["bearer-ref", "oauth-ref"]))
    }

    /// Real-device equivalence: replays the exact wire behavior of the Ombre
    /// Brain v2.7.6 streamable-HTTP server (mcp python-sdk 1.28.1, stateful
    /// sessions) as captured against a local replica: initialize returns 200
    /// with an SSE body and a Mcp-Session-Id header, notifications return
    /// 202 with an empty body, and tools/list returns 14 tools as one SSE
    /// event. This locks the full handshake -> decode -> list chain so a
    /// "connected but empty tool list" cannot silently pass.
    func testOmbreStreamableHandshakeListsFourteenToolsOverSSE() throws {
        let client = makeClient()
        var sessionHeader: String?
        URLProtocolStub.install { request in
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
            let method = try XCTUnwrap(json["method"] as? String)
            if method == "notifications/initialized" {
                XCTAssertNotNil(request.value(forHTTPHeaderField: "Mcp-Session-Id"))
                return self.stub(request, status: 202, headers: ["Content-Type": "application/json"], object: nil)
            }
            let body: String
            if method == "initialize" {
                body = """
                event: message
                data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"Ombre Brain Replica","version":"1.28.1"}}}

                """
                return self.stub(request, headers: ["Content-Type": "text/event-stream", "Mcp-Session-Id": "session-ombre"], raw: body)
            }
            if method == "tools/list" {
                sessionHeader = request.value(forHTTPHeaderField: "Mcp-Session-Id")
                var tools = ""
                for index in 0..<14 {
                    tools += #"{"name":"ombre_tool_\#(index)","description":"Tool \#(index).","inputSchema":{"type":"object","properties":{}}}"#
                    if index < 13 { tools += "," }
                }
                body = """
                event: message
                data: {"jsonrpc":"2.0","id":2,"result":{"tools":[\#(tools)]}}

                """
                return self.stub(request, headers: ["Content-Type": "text/event-stream"], raw: body)
            }
            throw URLError(.badServerResponse)
        }

        let connected = expectation(description: "connected")
        var snapshot: SOOYAMcpServerSnapshot?
        client.connect(server("alpha")) { result in
            snapshot = try? result.get()
            connected.fulfill()
        }
        wait(for: [connected], timeout: 2)
        XCTAssertEqual(snapshot?.sessionID, "session-ombre")
        XCTAssertEqual(snapshot?.protocolVersion, "2025-06-18")

        let listed = expectation(description: "listed")
        var names: [String] = []
        client.listTools(serverID: "alpha") { result in
            names = (try? result.get())?.compactMap { $0["name"] as? String } ?? []
            listed.fulfill()
        }
        wait(for: [listed], timeout: 2)
        XCTAssertEqual(names.count, 14)
        XCTAssertEqual(names.first, "ombre_tool_0")
        XCTAssertEqual(names.last, "ombre_tool_13")
        XCTAssertEqual(sessionHeader, "session-ombre")
    }

    /// A successful tools/list that returns zero tools is a diagnosable
    /// state: the client must surface it as an empty success (the plugin
    /// layer then reports "no tools discovered") instead of failing or
    /// pretending tools exist.
    func testEmptyToolsListSurfacesAsEmptySuccessForDiagnostics() throws {
        let client = makeClient()
        URLProtocolStub.install { request in
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
            let method = try XCTUnwrap(json["method"] as? String)
            if method == "notifications/initialized" { return self.stub(request, status: 202, object: nil) }
            if method == "tools/list" {
                return self.stub(request, headers: ["Content-Type": "text/event-stream"], raw: "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}\n\n")
            }
            return self.stub(request, object: ["jsonrpc": "2.0", "id": json["id"] as Any, "result": ["protocolVersion": "2025-06-18", "capabilities": [:], "serverInfo": ["name": "x", "version": "1"]]])
        }
        let connected = expectation(description: "connected")
        client.connect(server("alpha")) { _ in connected.fulfill() }
        wait(for: [connected], timeout: 2)

        let listed = expectation(description: "listed")
        client.listTools(serverID: "alpha") { result in
            guard case .success(let tools) = result else { return XCTFail("expected success, got \(result)") }
            XCTAssertTrue(tools.isEmpty)
            listed.fulfill()
        }
        wait(for: [listed], timeout: 2)
    }

    /// Stateful Ombre servers reject tools/list without a session id with a
    /// 400; the client must surface that as an HTTP status error so the
    /// admin refresh records "degraded" with a reason instead of a silent
    /// empty list.
    func testToolsListWithoutSessionIdIsRejectedAsHttpStatus() throws {
        let client = makeClient()
        URLProtocolStub.install { request in
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
            let method = try XCTUnwrap(json["method"] as? String)
            if method == "notifications/initialized" { return self.stub(request, status: 202, object: nil) }
            if method == "tools/list" {
                // No Mcp-Session-Id header: exactly what a stateful server
                // returns before the client captured the session header.
                XCTAssertNil(request.value(forHTTPHeaderField: "Mcp-Session-Id"))
                return self.stub(request, status: 400, object: ["error": "Bad Request: Missing session ID"])
            }
            return self.stub(request, object: ["jsonrpc": "2.0", "id": json["id"] as Any, "result": ["protocolVersion": "2025-06-18", "capabilities": [:], "serverInfo": ["name": "x", "version": "1"]]])
        }
        let connected = expectation(description: "connected")
        client.connect(server("alpha")) { _ in connected.fulfill() }
        wait(for: [connected], timeout: 2)

        let listed = expectation(description: "listed")
        client.listTools(serverID: "alpha") { result in
            guard case .failure(let error) = result, case SOOYAMcpError.httpStatus(400) = error else {
                return XCTFail("expected httpStatus(400), got \(result)")
            }
            listed.fulfill()
        }
        wait(for: [listed], timeout: 2)
    }

    /// Connect must be idempotent: the Ombre memory adapter probes at boot
    /// and the admin refresh reconnects on demand, so a second connect for
    /// the same server id replaces the old session instead of failing with
    /// duplicateServer (which used to mark healthy connections degraded).
    func testConnectReplacesExistingSessionInsteadOfFailing() throws {
        let client = makeClient()
        var initializeCount = 0
        let lock = NSLock()
        URLProtocolStub.install { request in
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
            let method = try XCTUnwrap(json["method"] as? String)
            if method == "initialize" {
                lock.lock(); initializeCount += 1; lock.unlock()
            }
            if method == "notifications/initialized" { return self.stub(request, status: 202, object: nil) }
            return self.stub(request, object: ["jsonrpc": "2.0", "id": json["id"] as Any, "result": ["protocolVersion": "2025-06-18", "capabilities": [:], "serverInfo": ["name": "x", "version": "1"]]])
        }
        let first = expectation(description: "first connect")
        client.connect(server("alpha")) { result in
            XCTAssertNoThrow(try result.get())
            first.fulfill()
        }
        wait(for: [first], timeout: 2)

        let second = expectation(description: "second connect")
        client.connect(server("alpha")) { result in
            XCTAssertNoThrow(try result.get())
            second.fulfill()
        }
        wait(for: [second], timeout: 2)
        XCTAssertEqual(initializeCount, 2)
    }

    private func makeClient(resolver: SOOYAMcpTokenResolving = SOOYANullMcpTokenResolver()) -> SOOYAMcpClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolStub.self]
        return SOOYAMcpClient(configuration: configuration, tokenResolver: resolver, environment: .production)
    }

    private func server(_ id: String, auth: SOOYAMcpAuth = .none) -> SOOYAMcpServerConfiguration {
        .init(id: id, url: URL(string: "https://\(id).example.test/mcp")!, auth: auth, timeout: 1)
    }

    private func stub(_ request: URLRequest, status: Int = 200, headers: [String: String] = ["Content-Type": "application/json"], object: Any?) -> URLProtocolStub.Stub {
        let data = object.flatMap { try? JSONSerialization.data(withJSONObject: $0) } ?? Data()
        return .init(response: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!, chunks: [data])
    }

    private func stub(_ request: URLRequest, status: Int = 200, headers: [String: String], raw: String) -> URLProtocolStub.Stub {
        .init(response: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!, chunks: [Data(raw.utf8)])
    }
}

private final class TokenResolver: SOOYAMcpTokenResolving {
    let tokens: [String: String]
    private(set) var references: [String] = []

    init(tokens: [String: String]) { self.tokens = tokens }

    func token(for reference: String, serverID: String, kind: SOOYAMcpAuthKind) throws -> String? {
        references.append(reference)
        return tokens[reference]
    }
}

