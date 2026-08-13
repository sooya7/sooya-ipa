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

