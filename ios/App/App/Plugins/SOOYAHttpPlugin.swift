import Foundation
import Capacitor

enum SOOYAHTTPEnvironment: Equatable {
    case development
    case production
}

enum SOOYAHTTPError: Error, Equatable, LocalizedError {
    case invalidURL
    case unsupportedScheme
    case insecureTransport
    case insecureRedirect
    case duplicateRequestID
    case invalidMethod
    case requestTooLarge
    case responseTooLarge
    case streamTooLarge
    case eventTooLarge
    case tooManyRedirects
    case invalidResponse
    case cancelled
    case timedOut
    case transportFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .unsupportedScheme: return "Only HTTP and HTTPS URLs are supported"
        case .insecureTransport: return "Production requests require HTTPS"
        case .insecureRedirect: return "HTTPS downgrade redirects are blocked"
        case .duplicateRequestID: return "The request id is already active"
        case .invalidMethod: return "Invalid HTTP method"
        case .requestTooLarge: return "Request body exceeds the configured limit"
        case .responseTooLarge: return "Response body exceeds the configured limit"
        case .streamTooLarge: return "Stream exceeds the configured limit"
        case .eventTooLarge: return "SSE event exceeds the configured limit"
        case .tooManyRedirects: return "Too many redirects"
        case .invalidResponse: return "The server returned an invalid HTTP response"
        case .cancelled: return "Request cancelled"
        case .timedOut: return "Request timed out"
        case .transportFailed(let message): return message
        }
    }
}

struct SOOYAHTTPPolicy {
    let environment: SOOYAHTTPEnvironment

    func validate(_ url: URL) throws {
        guard let scheme = url.scheme?.lowercased(), url.host != nil else {
            throw SOOYAHTTPError.invalidURL
        }
        guard scheme == "http" || scheme == "https" else {
            throw SOOYAHTTPError.unsupportedScheme
        }
        if environment == .production, scheme != "https" {
            throw SOOYAHTTPError.insecureTransport
        }
    }

    func redirectedRequest(from original: URLRequest, proposed: URLRequest) throws -> URLRequest {
        guard let source = original.url, let destination = proposed.url else {
            throw SOOYAHTTPError.invalidURL
        }
        if source.scheme?.lowercased() == "https", destination.scheme?.lowercased() != "https" {
            throw SOOYAHTTPError.insecureRedirect
        }
        try validate(destination)

        var result = proposed
        if origin(of: source) != origin(of: destination) {
            result.setValue(nil, forHTTPHeaderField: "Authorization")
            result.setValue(nil, forHTTPHeaderField: "Proxy-Authorization")
            result.setValue(nil, forHTTPHeaderField: "Cookie")
        }
        return result
    }

    private func origin(of url: URL) -> String {
        let scheme = url.scheme?.lowercased() ?? ""
        let host = url.host?.lowercased() ?? ""
        let defaultPort = scheme == "https" ? 443 : 80
        return "\(scheme)://\(host):\(url.port ?? defaultPort)"
    }
}

enum SOOYAHTTPSafeLog {
    static func describe(_ request: URLRequest) -> String {
        guard let url = request.url else { return request.httpMethod ?? "REQUEST" }
        var components = URLComponents()
        components.scheme = url.scheme
        components.host = url.host
        components.port = url.port
        components.path = url.path
        let safeURL = components.url?.absoluteString ?? "<redacted-url>"
        let safeHeaderNames = (request.allHTTPHeaderFields ?? [:]).keys
            .filter { !sensitiveHeaders.contains($0.lowercased()) }
            .sorted()
            .joined(separator: ",")
        return "\(request.httpMethod ?? "REQUEST") \(safeURL) headers=[\(safeHeaderNames)]"
    }

    private static let sensitiveHeaders: Set<String> = [
        "authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"
    ]
}

struct SOOYASSEEvent: Equatable {
    let id: String?
    let event: String?
    let data: String
    let retry: Int?
}

struct SOOYASSEParser {
    private var pending = Data()
    private var eventID: String?
    private var eventName: String?
    private var dataLines: [String] = []
    private var retry: Int?
    private var eventBytes = 0
    let maxEventBytes: Int

    init(maxEventBytes: Int) {
        self.maxEventBytes = maxEventBytes
    }

    mutating func consume(_ data: Data) throws -> [SOOYASSEEvent] {
        pending.append(data)
        var events: [SOOYASSEEvent] = []
        while let newline = pending.firstIndex(of: 0x0A) {
            var lineData = pending[..<newline]
            pending.removeSubrange(...newline)
            if lineData.last == 0x0D { lineData = lineData.dropLast() }
            guard let line = String(data: lineData, encoding: .utf8) else {
                throw SOOYAHTTPError.transportFailed("SSE stream is not valid UTF-8")
            }
            eventBytes += lineData.count + 1
            if eventBytes > maxEventBytes { throw SOOYAHTTPError.eventTooLarge }
            if let event = parse(line: line) { events.append(event) }
        }
        if pending.count + eventBytes > maxEventBytes { throw SOOYAHTTPError.eventTooLarge }
        return events
    }

    mutating func finish() throws -> [SOOYASSEEvent] {
        var events: [SOOYASSEEvent] = []
        if !pending.isEmpty {
            guard let line = String(data: pending, encoding: .utf8) else {
                throw SOOYAHTTPError.transportFailed("SSE stream is not valid UTF-8")
            }
            pending.removeAll(keepingCapacity: false)
            eventBytes += line.utf8.count
            if eventBytes > maxEventBytes { throw SOOYAHTTPError.eventTooLarge }
            _ = parse(line: line)
        }
        if !dataLines.isEmpty, let event = dispatch() { events.append(event) }
        return events
    }

    private mutating func parse(line: String) -> SOOYASSEEvent? {
        if line.isEmpty { return dispatch() }
        if line.hasPrefix(":") { return nil }
        let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let field = String(parts[0])
        var value = parts.count == 2 ? String(parts[1]) : ""
        if value.first == " " { value.removeFirst() }
        switch field {
        case "data": dataLines.append(value)
        case "event": eventName = value
        case "id" where !value.contains("\0"): eventID = value
        case "retry": retry = Int(value)
        default: break
        }
        return nil
    }

    private mutating func dispatch() -> SOOYASSEEvent? {
        defer {
            eventName = nil
            dataLines.removeAll(keepingCapacity: true)
            retry = nil
            eventBytes = 0
        }
        guard !dataLines.isEmpty else { return nil }
        return SOOYASSEEvent(id: eventID, event: eventName, data: dataLines.joined(separator: "\n"), retry: retry)
    }
}

struct SOOYAHTTPLimits {
    var maxRequestBytes = 16 * 1_024 * 1_024
    var maxResponseBytes = 32 * 1_024 * 1_024
    var maxStreamBytes = 64 * 1_024 * 1_024
    var maxChunkBytes = 64 * 1_024
    var maxRedirects = 5
}

struct SOOYAHTTPRequest {
    let id: String
    let url: URL
    var method: String = "GET"
    var headers: [String: String] = [:]
    var secretRef: String? = nil
    var secretHeader: String = "Authorization"
    var secretPrefix: String = "Bearer "
    var body: Data? = nil
    var timeout: TimeInterval = 30
}

struct SOOYAHTTPResponseHead {
    let status: Int
    let headers: [String: String]
    let url: URL
}

struct SOOYAHTTPResponse {
    let head: SOOYAHTTPResponseHead
    let body: Data
}

enum SOOYAHTTPStreamEvent {
    case headers(SOOYAHTTPResponseHead)
    case chunk(Data)
    case sse(SOOYASSEEvent)
    case complete
    case failure(SOOYAHTTPError)
}

final class SOOYAHTTPTransport: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    private final class Operation {
        enum Kind {
            case request((Result<SOOYAHTTPResponse, Error>) -> Void)
            case stream((SOOYAHTTPStreamEvent) -> Void)
        }

        let id: String
        let kind: Kind
        var head: SOOYAHTTPResponseHead?
        var body = Data()
        var received = 0
        var redirects = 0
        var isSSE = false
        var parser: SOOYASSEParser

        init(id: String, kind: Kind, maxEventBytes: Int) {
            self.id = id
            self.kind = kind
            self.parser = SOOYASSEParser(maxEventBytes: maxEventBytes)
        }
    }

    private let policy: SOOYAHTTPPolicy
    private let limits: SOOYAHTTPLimits
    private let lock = NSLock()
    private var operations: [Int: Operation] = [:]
    private var taskByID: [String: URLSessionDataTask] = [:]
    private var session: URLSession!
    private lazy var secretStore: SOOYAKeychainStore = {
        let group = (try? SOOYAKeychainAccessGroupResolver().resolve()) ?? "TEAMID.com.sooya.app"
        return SOOYAKeychainStore(identity: SOOYAKeychainIdentity(accessGroup: group))
    }()

    init(configuration: URLSessionConfiguration = .ephemeral,
         policy: SOOYAHTTPPolicy,
         limits: SOOYAHTTPLimits = SOOYAHTTPLimits()) {
        self.policy = policy
        self.limits = limits
        super.init()
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .userInitiated
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    }

    deinit { session.invalidateAndCancel() }

    @discardableResult
    func request(_ request: SOOYAHTTPRequest,
                 completion: @escaping (Result<SOOYAHTTPResponse, Error>) -> Void) throws -> String {
        try start(request, kind: .request(completion))
    }

    @discardableResult
    func stream(_ request: SOOYAHTTPRequest,
                event: @escaping (SOOYAHTTPStreamEvent) -> Void) throws -> String {
        try start(request, kind: .stream(event))
    }

    @discardableResult
    func cancel(id: String) -> Bool {
        lock.lock()
        guard let task = taskByID.removeValue(forKey: id), let operation = operations.removeValue(forKey: task.taskIdentifier) else {
            lock.unlock()
            return false
        }
        lock.unlock()
        task.cancel()
        deliverFailure(.cancelled, operation: operation)
        return true
    }

    private func start(_ input: SOOYAHTTPRequest, kind: Operation.Kind) throws -> String {
        try policy.validate(input.url)
        let method = input.method.uppercased()
        guard !method.isEmpty, method.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "!#$%&'*+-.^_`|~")).contains($0) }) else {
            throw SOOYAHTTPError.invalidMethod
        }
        guard (input.body?.count ?? 0) <= limits.maxRequestBytes else { throw SOOYAHTTPError.requestTooLarge }
        guard input.timeout > 0 else { throw SOOYAHTTPError.timedOut }

        var request = URLRequest(url: input.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: input.timeout)
        request.httpMethod = method
        request.httpBody = input.body
        for (name, value) in input.headers { request.setValue(value, forHTTPHeaderField: name) }
        if let secretRef = input.secretRef {
            guard let secret = try secretStore.read(key: secretRef), !secret.isEmpty else {
                throw SOOYAHTTPError.transportFailed("secret reference unavailable")
            }
            request.setValue(input.secretPrefix + secret, forHTTPHeaderField: input.secretHeader)
        }

        lock.lock()
        guard taskByID[input.id] == nil else {
            lock.unlock()
            throw SOOYAHTTPError.duplicateRequestID
        }
        let task = session.dataTask(with: request)
        operations[task.taskIdentifier] = Operation(id: input.id, kind: kind, maxEventBytes: limits.maxChunkBytes)
        taskByID[input.id] = task
        lock.unlock()
        task.resume()
        return input.id
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, let url = http.url else {
            completionHandler(.cancel)
            finish(task: dataTask, error: .invalidResponse)
            return
        }
        let headers = http.allHeaderFields.reduce(into: [String: String]()) { result, pair in
            result[String(describing: pair.key)] = String(describing: pair.value)
        }
        let head = SOOYAHTTPResponseHead(status: http.statusCode, headers: headers, url: url)
        let declared = response.expectedContentLength

        lock.lock()
        guard let operation = operations[dataTask.taskIdentifier] else {
            lock.unlock()
            completionHandler(.cancel)
            return
        }
        operation.head = head
        operation.isSSE = http.value(forHTTPHeaderField: "Content-Type")?.lowercased().contains("text/event-stream") == true
        let limit = isStream(operation) ? limits.maxStreamBytes : limits.maxResponseBytes
        let tooLarge = declared > 0 && declared > Int64(limit)
        let callback = streamCallback(operation)
        lock.unlock()

        if tooLarge {
            completionHandler(.cancel)
            finish(task: dataTask, error: isStream(operation) ? .streamTooLarge : .responseTooLarge)
            return
        }
        callback?(.headers(head))
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        guard let operation = operations[dataTask.taskIdentifier] else { lock.unlock(); return }
        operation.received += data.count
        let stream = isStream(operation)
        let exceeded = operation.received > (stream ? limits.maxStreamBytes : limits.maxResponseBytes)
        if !stream, !exceeded { operation.body.append(data) }
        var streamEvents: [SOOYAHTTPStreamEvent] = []
        var parseError: SOOYAHTTPError?
        if stream, !exceeded {
            if operation.isSSE {
                do { streamEvents = try operation.parser.consume(data).map(SOOYAHTTPStreamEvent.sse) }
                catch let error as SOOYAHTTPError { parseError = error }
                catch { parseError = .transportFailed("Invalid SSE stream") }
            } else {
                var offset = 0
                while offset < data.count {
                    let end = min(offset + max(1, limits.maxChunkBytes), data.count)
                    streamEvents.append(.chunk(data.subdata(in: offset..<end)))
                    offset = end
                }
            }
        }
        let callback = streamCallback(operation)
        lock.unlock()

        if exceeded || parseError != nil {
            dataTask.cancel()
            finish(task: dataTask, error: parseError ?? (stream ? .streamTooLarge : .responseTooLarge))
            return
        }
        streamEvents.forEach { callback?($0) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        lock.lock()
        guard let operation = operations[task.taskIdentifier] else { lock.unlock(); completionHandler(nil); return }
        operation.redirects += 1
        let tooMany = operation.redirects > limits.maxRedirects
        lock.unlock()
        if tooMany {
            completionHandler(nil)
            finish(task: task, error: .tooManyRedirects)
            return
        }
        do {
            completionHandler(try policy.redirectedRequest(from: task.currentRequest ?? task.originalRequest ?? request, proposed: request))
        } catch let error as SOOYAHTTPError {
            completionHandler(nil)
            finish(task: task, error: error)
        } catch {
            completionHandler(nil)
            finish(task: task, error: .transportFailed("Redirect rejected"))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let urlError = error as? URLError {
            finish(task: task, error: urlError.code == .timedOut ? .timedOut : (urlError.code == .cancelled ? .cancelled : .transportFailed(urlError.localizedDescription)))
        } else if let error {
            finish(task: task, error: .transportFailed(error.localizedDescription))
        } else {
            finish(task: task, error: nil)
        }
    }

    private func finish(task: URLSessionTask, error: SOOYAHTTPError?) {
        lock.lock()
        guard let operation = operations.removeValue(forKey: task.taskIdentifier) else { lock.unlock(); return }
        taskByID.removeValue(forKey: operation.id)
        var trailing: [SOOYAHTTPStreamEvent] = []
        var finalError = error
        if finalError == nil, isStream(operation), operation.isSSE {
            do { trailing = try operation.parser.finish().map(SOOYAHTTPStreamEvent.sse) }
            catch let value as SOOYAHTTPError { finalError = value }
            catch { finalError = .transportFailed("Invalid SSE stream") }
        }
        lock.unlock()

        if let finalError { deliverFailure(finalError, operation: operation); return }
        switch operation.kind {
        case .request(let completion):
            guard let head = operation.head else { completion(.failure(SOOYAHTTPError.invalidResponse)); return }
            completion(.success(SOOYAHTTPResponse(head: head, body: operation.body)))
        case .stream(let callback):
            trailing.forEach(callback)
            callback(.complete)
        }
    }

    private func deliverFailure(_ error: SOOYAHTTPError, operation: Operation) {
        switch operation.kind {
        case .request(let completion): completion(.failure(error))
        case .stream(let callback): callback(.failure(error))
        }
    }

    private func isStream(_ operation: Operation) -> Bool {
        if case .stream = operation.kind { return true }
        return false
    }

    private func streamCallback(_ operation: Operation) -> ((SOOYAHTTPStreamEvent) -> Void)? {
        if case .stream(let callback) = operation.kind { return callback }
        return nil
    }
}

@objc(SOOYAHttpPlugin)
public final class SOOYAHttpPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SOOYAHttpPlugin"
    public let jsName = "SOOYAHttp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stream", returnType: CAPPluginReturnCallback),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    private lazy var transport = SOOYAHTTPTransport(policy: SOOYAHTTPPolicy(environment: .production))

    @objc public func request(_ call: CAPPluginCall) {
        do {
            let input = try makeRequest(call)
            try transport.request(input) { result in
                switch result {
                case .success(let response):
                    call.resolve(self.encode(response))
                case .failure(let error):
                    self.reject(call, error)
                }
            }
        } catch { reject(call, error) }
    }

    @objc public func stream(_ call: CAPPluginCall) {
        do {
            let input = try makeRequest(call)
            call.keepAlive = true
            try transport.stream(input) { event in
                switch event {
                case .headers(let head):
                    call.resolve(["type": "headers", "id": input.id, "status": head.status, "headers": head.headers, "url": head.url.absoluteString])
                case .chunk(let data):
                    call.resolve(["type": "chunk", "id": input.id, "dataBase64": data.base64EncodedString()])
                case .sse(let value):
                    call.resolve(["type": "sse", "id": input.id, "event": value.event.map { $0 as Any } ?? NSNull(), "eventId": value.id.map { $0 as Any } ?? NSNull(), "data": value.data, "retry": value.retry.map { $0 as Any } ?? NSNull()])
                case .complete:
                    call.keepAlive = false
                    call.resolve(["type": "complete", "id": input.id])
                case .failure(let error):
                    call.keepAlive = false
                    self.reject(call, error)
                }
            }
        } catch {
            call.keepAlive = false
            reject(call, error)
        }
    }

    @objc public func cancel(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else { call.reject("Missing id", "INVALID_ARGUMENT"); return }
        call.resolve(["cancelled": transport.cancel(id: id)])
    }

    private func makeRequest(_ call: CAPPluginCall) throws -> SOOYAHTTPRequest {
        guard let rawURL = call.getString("url"), let url = URL(string: rawURL) else { throw SOOYAHTTPError.invalidURL }
        let id = call.getString("id") ?? UUID().uuidString.lowercased()
        let headers = (call.getObject("headers") ?? [:]).reduce(into: [String: String]()) { result, pair in
            if let value = pair.value as? String { result[pair.key] = value }
        }
        var body: Data?
        if let base64 = call.getString("bodyBase64") {
            guard let decoded = Data(base64Encoded: base64) else { throw SOOYAHTTPError.transportFailed("Invalid base64 body") }
            body = decoded
        } else if let text = call.getString("bodyText") {
            body = Data(text.utf8)
        }
        return SOOYAHTTPRequest(
            id: id,
            url: url,
            method: call.getString("method") ?? "GET",
            headers: headers,
            secretRef: call.getString("secretRef"),
            secretHeader: call.getString("secretHeader") ?? "Authorization",
            secretPrefix: call.getString("secretPrefix") ?? "Bearer ",
            body: body,
            timeout: Double(call.getInt("timeoutMs") ?? 30_000) / 1_000
        )
    }

    private func encode(_ response: SOOYAHTTPResponse) -> PluginCallResultData {
        [
            "status": response.head.status,
            "headers": response.head.headers,
            "url": response.head.url.absoluteString,
            "dataBase64": response.body.base64EncodedString(),
            "dataText": String(data: response.body, encoding: .utf8).map { $0 as Any } ?? NSNull()
        ]
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        let value = error as? SOOYAHTTPError ?? .transportFailed(error.localizedDescription)
        call.reject(value.localizedDescription, String(describing: value), value)
    }
}
