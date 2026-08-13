import XCTest
@testable import App

final class SOOYAHttpPluginTests: XCTestCase {
    override func tearDown() {
        URLProtocolStub.reset()
        super.tearDown()
    }

    func testProductionPolicyRejectsCleartextAndUnsupportedSchemes() throws {
        let policy = SOOYAHTTPPolicy(environment: .production)

        XCTAssertThrowsError(try policy.validate(URL(string: "http://api.example.test/v1")!)) { error in
            XCTAssertEqual(error as? SOOYAHTTPError, .insecureTransport)
        }
        XCTAssertThrowsError(try policy.validate(URL(string: "file:///private/data")!)) { error in
            XCTAssertEqual(error as? SOOYAHTTPError, .unsupportedScheme)
        }
        XCTAssertNoThrow(try policy.validate(URL(string: "https://api.example.test/v1")!))
    }

    func testRedirectStripsAuthorizationAcrossHostsAndRejectsDowngrade() throws {
        let policy = SOOYAHTTPPolicy(environment: .production)
        var original = URLRequest(url: URL(string: "https://one.example.test/start")!)
        original.setValue("Bearer secret-value", forHTTPHeaderField: "Authorization")
        original.setValue("safe", forHTTPHeaderField: "X-Trace")

        var crossHost = URLRequest(url: URL(string: "https://two.example.test/next")!)
        crossHost.allHTTPHeaderFields = original.allHTTPHeaderFields
        let sanitized = try policy.redirectedRequest(from: original, proposed: crossHost)
        XCTAssertNil(sanitized.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(sanitized.value(forHTTPHeaderField: "X-Trace"), "safe")

        var sameHost = URLRequest(url: URL(string: "https://one.example.test/next")!)
        sameHost.allHTTPHeaderFields = original.allHTTPHeaderFields
        XCTAssertEqual(
            try policy.redirectedRequest(from: original, proposed: sameHost)
                .value(forHTTPHeaderField: "Authorization"),
            "Bearer secret-value"
        )

        let downgrade = URLRequest(url: URL(string: "http://one.example.test/insecure")!)
        XCTAssertThrowsError(try policy.redirectedRequest(from: original, proposed: downgrade)) { error in
            XCTAssertEqual(error as? SOOYAHTTPError, .insecureRedirect)
        }
    }

    func testSafeLogNeverContainsCredentials() {
        var request = URLRequest(url: URL(string: "https://user:password@example.test/path?token=query-secret&ok=1")!)
        request.httpMethod = "POST"
        request.setValue("Bearer header-secret", forHTTPHeaderField: "Authorization")
        request.setValue("session=private-cookie", forHTTPHeaderField: "Cookie")

        let text = SOOYAHTTPSafeLog.describe(request)

        XCTAssertTrue(text.contains("POST"))
        XCTAssertTrue(text.contains("example.test/path"))
        XCTAssertFalse(text.contains("password"))
        XCTAssertFalse(text.contains("query-secret"))
        XCTAssertFalse(text.contains("header-secret"))
        XCTAssertFalse(text.contains("private-cookie"))
    }

    func testSSEParserHandlesSplitCRLFAndMultilineData() throws {
        var parser = SOOYASSEParser(maxEventBytes: 1_024)

        XCTAssertEqual(try parser.consume(Data("id: 7\r\nevent: mes".utf8)), [])
        let events = try parser.consume(Data("sage\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\n".utf8))

        XCTAssertEqual(events, [SOOYASSEEvent(id: "7", event: "message", data: "{\"a\":\n1}", retry: nil)])
    }

    func testRequestStopsAtConfiguredResponseLimit() throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolStub.self]
        let transport = SOOYAHTTPTransport(
            configuration: configuration,
            policy: SOOYAHTTPPolicy(environment: .production),
            limits: SOOYAHTTPLimits(maxRequestBytes: 32, maxResponseBytes: 4, maxStreamBytes: 32, maxChunkBytes: 16)
        )
        URLProtocolStub.install { request in
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return .init(response: response, chunks: [Data("12345".utf8)])
        }
        let finished = expectation(description: "request completes")
        var captured: Result<SOOYAHTTPResponse, Error>?

        _ = try transport.request(
            SOOYAHTTPRequest(id: "too-large", url: URL(string: "https://example.test/large")!)
        ) { result in
            captured = result
            finished.fulfill()
        }

        wait(for: [finished], timeout: 1)
        XCTAssertEqual(try XCTUnwrap(captured).failure as? SOOYAHTTPError, .responseTooLarge)
    }

    func testCancelAbortsOutstandingStreamExactlyOnce() throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolStub.self]
        let transport = SOOYAHTTPTransport(configuration: configuration, policy: .init(environment: .production))
        URLProtocolStub.install { request in
            let response = HTTPURLResponse(url: try XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!
            return .init(response: response, chunks: [], finishes: false)
        }
        let cancelled = expectation(description: "cancel event")
        var failures = 0

        _ = try transport.stream(
            SOOYAHTTPRequest(id: "stream-1", url: URL(string: "https://example.test/events")!)
        ) { event in
            if case .failure(let error) = event {
                failures += 1
                XCTAssertEqual(error, .cancelled)
                cancelled.fulfill()
            }
        }

        XCTAssertTrue(transport.cancel(id: "stream-1"))
        XCTAssertFalse(transport.cancel(id: "stream-1"))
        wait(for: [cancelled], timeout: 1)
        XCTAssertEqual(failures, 1)
    }
}

private extension Result {
    var failure: Failure? {
        guard case .failure(let error) = self else { return nil }
        return error
    }
}
