import Foundation

final class URLProtocolStub: URLProtocol {
    struct Stub {
        let response: HTTPURLResponse
        let chunks: [Data]
        var error: Error?
        var finishes: Bool = true
    }

    typealias Handler = (URLRequest) throws -> Stub

    private static let lock = NSLock()
    private static var handler: Handler?
    private var stopped = false

    static func install(_ handler: @escaping Handler) {
        lock.lock()
        self.handler = handler
        lock.unlock()
    }

    static func reset() {
        lock.lock()
        handler = nil
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        let handler = Self.handler
        Self.lock.unlock()

        guard let handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }

        do {
            let stub = try handler(request)
            guard !stopped else { return }
            client?.urlProtocol(self, didReceive: stub.response, cacheStoragePolicy: .notAllowed)
            for chunk in stub.chunks where !stopped {
                client?.urlProtocol(self, didLoad: chunk)
            }
            if let error = stub.error, !stopped {
                client?.urlProtocol(self, didFailWithError: error)
            } else if stub.finishes, !stopped {
                client?.urlProtocolDidFinishLoading(self)
            }
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {
        stopped = true
    }
}

