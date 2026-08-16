import Foundation
import Capacitor

enum SOOYAMcpAuthKind: String {
    case none
    case bearer
    case oauth
}

enum SOOYAMcpAuth: Equatable {
    case none
    case bearer(tokenReference: String)
    case oauth(tokenReference: String)

    var kind: SOOYAMcpAuthKind {
        switch self {
        case .none: return .none
        case .bearer: return .bearer
        case .oauth: return .oauth
        }
    }

    var tokenReference: String? {
        switch self {
        case .none: return nil
        case .bearer(let value), .oauth(let value): return value
        }
    }
}

protocol SOOYAMcpTokenResolving: AnyObject {
    func token(for reference: String, serverID: String, kind: SOOYAMcpAuthKind) throws -> String?
}

final class SOOYANullMcpTokenResolver: SOOYAMcpTokenResolving {
    func token(for reference: String, serverID: String, kind: SOOYAMcpAuthKind) throws -> String? { nil }
}

/// MCP authentication follows the same opaque-reference rule as provider
/// HTTP: JavaScript stores only the reference and native resolves the secret
/// immediately before the request leaves the device.
final class SOOYAKeychainMcpTokenResolver: SOOYAMcpTokenResolving {
    private lazy var store = SOOYAKeychainStore()

    func token(for reference: String, serverID: String, kind: SOOYAMcpAuthKind) throws -> String? {
        try store.read(key: reference)
    }
}

enum SOOYAMcpTransportMode: String, Equatable {
    case streamableHTTP
    case legacySSE
}

enum SOOYAMcpError: Error, Equatable, LocalizedError {
    case invalidServerID
    case duplicateServer
    case serverNotConnected
    case unsupportedTransport
    case missingTokenReference
    case tokenUnavailable
    case invalidResponse
    case httpStatus(Int)
    case protocolError(Int, String)
    case legacyEndpointMissing
    case paginationLimit
    case cancelled
    case timedOut
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .invalidServerID: return "Invalid MCP server id"
        case .duplicateServer: return "MCP server is already connecting"
        case .serverNotConnected: return "MCP server is not connected"
        case .unsupportedTransport: return "stdio MCP transport is not supported on iOS"
        case .missingTokenReference: return "MCP authentication requires a token reference"
        case .tokenUnavailable: return "MCP token reference could not be resolved"
        case .invalidResponse: return "Invalid MCP response"
        case .httpStatus(let status): return "MCP server returned HTTP \(status)"
        case .protocolError(let code, let message): return "MCP error \(code): \(message)"
        case .legacyEndpointMissing: return "Legacy MCP endpoint event was not received"
        case .paginationLimit: return "MCP pagination limit exceeded"
        case .cancelled: return "MCP operation cancelled"
        case .timedOut: return "MCP operation timed out"
        case .transport(let message): return message
        }
    }
}

struct SOOYAMcpServerConfiguration {
    let id: String
    let url: URL
    var auth: SOOYAMcpAuth = .none
    var timeout: TimeInterval = 30
    var maxPages: Int = 100
}

struct SOOYAMcpServerSnapshot {
    let id: String
    let mode: SOOYAMcpTransportMode
    let endpoint: URL
    let sessionID: String?
    let protocolVersion: String
}

final class SOOYAMcpClient {
    private final class State {
        let configuration: SOOYAMcpServerConfiguration
        var mode: SOOYAMcpTransportMode = .streamableHTTP
        var endpoint: URL
        var sessionID: String?
        var protocolVersion = "2025-06-18"
        var nextRequestID = 1
        var tasks: [String: URLSessionTask] = [:]
        var connecting = true

        init(configuration: SOOYAMcpServerConfiguration) {
            self.configuration = configuration
            self.endpoint = configuration.url
        }
    }

    private struct HTTPResult {
        let status: Int
        let headers: [AnyHashable: Any]
        let data: Data
    }

    private let configuration: URLSessionConfiguration
    private let tokenResolver: SOOYAMcpTokenResolving
    private let policy: SOOYAHTTPPolicy
    private let lock = NSRecursiveLock()
    private var states: [String: State] = [:]

    init(configuration: URLSessionConfiguration = .ephemeral,
         tokenResolver: SOOYAMcpTokenResolving = SOOYANullMcpTokenResolver(),
         environment: SOOYAHTTPEnvironment = .production) {
        self.configuration = configuration
        self.tokenResolver = tokenResolver
        self.policy = SOOYAHTTPPolicy(environment: environment)
    }

    func connect(_ server: SOOYAMcpServerConfiguration,
                 completion: @escaping (Result<SOOYAMcpServerSnapshot, Error>) -> Void) {
        do {
            try policy.validate(server.url)
            guard validServerID(server.id) else { throw SOOYAMcpError.invalidServerID }
            guard server.timeout > 0, server.maxPages > 0 else { throw SOOYAMcpError.invalidResponse }
            _ = try authorization(for: server)
            lock.lock()
            // Idempotent connect: a previous session (e.g. the Ombre memory
            // adapter's boot-time probe) must not make a later admin refresh
            // fail with duplicateServer. Tear the old state down and replace
            // it, exactly like an explicit disconnect followed by connect.
            let stale = states.removeValue(forKey: server.id)
            let staleTasks = stale?.tasks.values ?? Dictionary<String, URLSessionTask>().values
            let state = State(configuration: server)
            states[server.id] = state
            lock.unlock()
            staleTasks.forEach { $0.cancel() }
            initialize(state: state, allowLegacy: true, completion: completion)
        } catch { completion(.failure(error)) }
    }

    func disconnect(serverID: String) {
        lock.lock()
        let state = states.removeValue(forKey: serverID)
        let tasks = state?.tasks.values ?? Dictionary<String, URLSessionTask>().values
        lock.unlock()
        tasks.forEach { $0.cancel() }
    }

    @discardableResult
    func cancel(serverID: String, operationID: String) -> Bool {
        lock.lock()
        let task = states[serverID]?.tasks.removeValue(forKey: operationID)
        lock.unlock()
        task?.cancel()
        return task != nil
    }

    func snapshot(serverID: String) -> SOOYAMcpServerSnapshot? {
        lock.lock(); defer { lock.unlock() }
        guard let state = states[serverID], !state.connecting else { return nil }
        return makeSnapshot(state)
    }

    @discardableResult
    func listTools(serverID: String,
                   operationID: String = UUID().uuidString.lowercased(),
                   completion: @escaping (Result<[[String: Any]], Error>) -> Void) -> String {
        guard let state = connectedState(serverID) else {
            completion(.failure(SOOYAMcpError.serverNotConnected))
            return operationID
        }
        listTools(state: state, cursor: nil, page: 0, collected: [], operationID: operationID, completion: completion)
        return operationID
    }

    @discardableResult
    func callTool(serverID: String,
                  name: String,
                  arguments: [String: Any],
                  operationID: String = UUID().uuidString.lowercased(),
                  completion: @escaping (Result<[String: Any], Error>) -> Void) -> String {
        guard let state = connectedState(serverID), !name.isEmpty else { completion(.failure(SOOYAMcpError.serverNotConnected)); return operationID }
        send(state: state, method: "tools/call", params: ["name": name, "arguments": arguments], notification: false, operationID: operationID) { result in
            completion(result.flatMap { json in
                guard let payload = json["result"] as? [String: Any] else { return .failure(SOOYAMcpError.invalidResponse) }
                return .success(payload)
            })
        }
        return operationID
    }

    private func initialize(state: State,
                            allowLegacy: Bool,
                            completion: @escaping (Result<SOOYAMcpServerSnapshot, Error>) -> Void) {
        let params: [String: Any] = [
            "protocolVersion": state.mode == .legacySSE ? "2024-11-05" : "2025-06-18",
            "capabilities": [:],
            "clientInfo": ["name": "sooya-ios", "version": "1.0.0"]
        ]
        send(state: state, method: "initialize", params: params, notification: false, accept4xx: allowLegacy) { result in
            switch result {
            case .success(let json):
                if let fallbackStatus = json["__httpStatus"] as? Int, (400...499).contains(fallbackStatus), allowLegacy {
                    self.beginLegacy(state: state, completion: completion)
                    return
                }
                guard let payload = json["result"] as? [String: Any], let version = payload["protocolVersion"] as? String else {
                    self.failConnect(state, error: SOOYAMcpError.invalidResponse, completion: completion)
                    return
                }
                self.lock.lock()
                state.protocolVersion = version
                self.lock.unlock()
                self.send(state: state, method: "notifications/initialized", params: nil, notification: true) { notificationResult in
                    switch notificationResult {
                    case .success:
                        self.lock.lock(); state.connecting = false; let snapshot = self.makeSnapshot(state); self.lock.unlock()
                        completion(.success(snapshot))
                    case .failure(let error): self.failConnect(state, error: error, completion: completion)
                    }
                }
            case .failure(let error): self.failConnect(state, error: error, completion: completion)
            }
        }
    }

    private func beginLegacy(state: State,
                             completion: @escaping (Result<SOOYAMcpServerSnapshot, Error>) -> Void) {
        var request = URLRequest(url: state.configuration.url, timeoutInterval: state.configuration.timeout)
        request.httpMethod = "GET"
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        do { try applyAuthorization(to: &request, state: state) }
        catch { failConnect(state, error: error, completion: completion); return }
        perform(state: state, request: request) { result in
            switch result {
            case .success(let response):
                guard (200...299).contains(response.status), let endpoint = self.legacyEndpoint(from: response.data, base: state.configuration.url) else {
                    self.failConnect(state, error: SOOYAMcpError.legacyEndpointMissing, completion: completion)
                    return
                }
                do { try self.policy.validate(endpoint) }
                catch { self.failConnect(state, error: error, completion: completion); return }
                self.lock.lock(); state.mode = .legacySSE; state.endpoint = endpoint; state.protocolVersion = "2024-11-05"; self.lock.unlock()
                self.initialize(state: state, allowLegacy: false, completion: completion)
            case .failure(let error): self.failConnect(state, error: error, completion: completion)
            }
        }
    }

    private func listTools(state: State,
                           cursor: String?,
                           page: Int,
                           collected: [[String: Any]],
                           operationID: String,
                           completion: @escaping (Result<[[String: Any]], Error>) -> Void) {
        guard page < state.configuration.maxPages else { completion(.failure(SOOYAMcpError.paginationLimit)); return }
        let params: [String: Any]? = cursor.map { ["cursor": $0] }
        send(state: state, method: "tools/list", params: params, notification: false, operationID: operationID) { result in
            switch result {
            case .success(let json):
                guard let payload = json["result"] as? [String: Any], let tools = payload["tools"] as? [[String: Any]] else {
                    completion(.failure(SOOYAMcpError.invalidResponse)); return
                }
                let merged = collected + tools
                if payload.keys.contains("nextCursor"), let next = payload["nextCursor"] as? String {
                    self.listTools(state: state, cursor: next, page: page + 1, collected: merged, operationID: operationID, completion: completion)
                } else {
                    completion(.success(merged))
                }
            case .failure(let error): completion(.failure(error))
            }
        }
    }

    private func send(state: State,
                      method: String,
                      params: [String: Any]?,
                      notification: Bool,
                      accept4xx: Bool = false,
                      operationID: String? = nil,
                      completion: @escaping (Result<[String: Any], Error>) -> Void) {
        lock.lock()
        let requestID = state.nextRequestID
        if !notification { state.nextRequestID += 1 }
        let endpoint = state.endpoint
        lock.unlock()
        var message: [String: Any] = ["jsonrpc": "2.0", "method": method]
        if !notification { message["id"] = requestID }
        if let params { message["params"] = params }
        guard JSONSerialization.isValidJSONObject(message), let body = try? JSONSerialization.data(withJSONObject: message) else {
            completion(.failure(SOOYAMcpError.invalidResponse)); return
        }
        var request = URLRequest(url: endpoint, timeoutInterval: state.configuration.timeout)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue(state.protocolVersion, forHTTPHeaderField: "MCP-Protocol-Version")
        if let sessionID = state.sessionID { request.setValue(sessionID, forHTTPHeaderField: "Mcp-Session-Id") }
        do { try applyAuthorization(to: &request, state: state) }
        catch { completion(.failure(error)); return }

        perform(state: state, request: request, operationID: operationID) { result in
            switch result {
            case .success(let response):
                if let session = self.header("Mcp-Session-Id", in: response.headers) {
                    self.lock.lock(); state.sessionID = session; self.lock.unlock()
                }
                if accept4xx, (400...499).contains(response.status) {
                    completion(.success(["__httpStatus": response.status])); return
                }
                guard (200...299).contains(response.status) else { completion(.failure(SOOYAMcpError.httpStatus(response.status))); return }
                if notification, response.data.isEmpty { completion(.success([:])); return }
                do {
                    let json = try self.decodeMessage(response.data, contentType: self.header("Content-Type", in: response.headers))
                    if let error = json["error"] as? [String: Any], let code = error["code"] as? Int, let message = error["message"] as? String {
                        completion(.failure(SOOYAMcpError.protocolError(code, message)))
                    } else { completion(.success(json)) }
                } catch { completion(.failure(error)) }
            case .failure(let error): completion(.failure(error))
            }
        }
    }

    private func perform(state: State,
                         request: URLRequest,
                         operationID requestedOperationID: String? = nil,
                         completion: @escaping (Result<HTTPResult, Error>) -> Void) {
        let operationID = requestedOperationID ?? UUID().uuidString.lowercased()
        let session = URLSession(configuration: configuration)
        let task = session.dataTask(with: request) { data, response, error in
            session.finishTasksAndInvalidate()
            self.lock.lock(); state.tasks.removeValue(forKey: operationID); self.lock.unlock()
            if let urlError = error as? URLError {
                completion(.failure(urlError.code == .timedOut ? SOOYAMcpError.timedOut : (urlError.code == .cancelled ? SOOYAMcpError.cancelled : SOOYAMcpError.transport(urlError.localizedDescription))))
                return
            }
            if let error { completion(.failure(SOOYAMcpError.transport(error.localizedDescription))); return }
            guard let http = response as? HTTPURLResponse else { completion(.failure(SOOYAMcpError.invalidResponse)); return }
            completion(.success(HTTPResult(status: http.statusCode, headers: http.allHeaderFields, data: data ?? Data())))
        }
        lock.lock(); state.tasks[operationID] = task; lock.unlock()
        task.resume()
    }

    private func decodeMessage(_ data: Data, contentType: String?) throws -> [String: Any] {
        if contentType?.lowercased().contains("text/event-stream") == true {
            var parser = SOOYASSEParser(maxEventBytes: 8 * 1_024 * 1_024)
            var events = try parser.consume(data)
            events.append(contentsOf: try parser.finish())
            for event in events.reversed() {
                if let payload = event.data.data(using: .utf8), let json = try JSONSerialization.jsonObject(with: payload) as? [String: Any] {
                    return json
                }
            }
            throw SOOYAMcpError.invalidResponse
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw SOOYAMcpError.invalidResponse }
        return json
    }

    private func legacyEndpoint(from data: Data, base: URL) -> URL? {
        var parser = SOOYASSEParser(maxEventBytes: 1_024 * 1_024)
        guard var events = try? parser.consume(data) else { return nil }
        guard let trailing = try? parser.finish() else { return nil }
        events.append(contentsOf: trailing)
        guard let value = events.first(where: { $0.event == "endpoint" })?.data else { return nil }
        return URL(string: value, relativeTo: base)?.absoluteURL
    }

    private func authorization(for server: SOOYAMcpServerConfiguration) throws -> String? {
        guard let reference = server.auth.tokenReference else { return nil }
        guard !reference.isEmpty else { throw SOOYAMcpError.missingTokenReference }
        guard let value = try tokenResolver.token(for: reference, serverID: server.id, kind: server.auth.kind), !value.isEmpty else {
            throw SOOYAMcpError.tokenUnavailable
        }
        return value
    }

    private func applyAuthorization(to request: inout URLRequest, state: State) throws {
        if let token = try authorization(for: state.configuration) {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }

    private func connectedState(_ id: String) -> State? {
        lock.lock(); defer { lock.unlock() }
        guard let state = states[id], !state.connecting else { return nil }
        return state
    }

    private func failConnect(_ state: State,
                             error: Error,
                             completion: (Result<SOOYAMcpServerSnapshot, Error>) -> Void) {
        lock.lock(); states.removeValue(forKey: state.configuration.id); let tasks = state.tasks.values; lock.unlock()
        tasks.forEach { $0.cancel() }
        completion(.failure(error))
    }

    private func makeSnapshot(_ state: State) -> SOOYAMcpServerSnapshot {
        .init(id: state.configuration.id, mode: state.mode, endpoint: state.endpoint, sessionID: state.sessionID, protocolVersion: state.protocolVersion)
    }

    private func validServerID(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 128 && value.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-")).contains($0) }
    }

    private func header(_ name: String, in headers: [AnyHashable: Any]) -> String? {
        headers.first { String(describing: $0.key).caseInsensitiveCompare(name) == .orderedSame }.map { String(describing: $0.value) }
    }
}

@objc(SOOYAMcpPlugin)
public final class SOOYAMcpPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SOOYAMcpPlugin"
    public let jsName = "SOOYAMcp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listTools", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "callTool", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    static weak var tokenResolver: SOOYAMcpTokenResolving?
    private lazy var client = SOOYAMcpClient(tokenResolver: Self.tokenResolver ?? SOOYAKeychainMcpTokenResolver())

    @objc public func connect(_ call: CAPPluginCall) {
        do {
            let server = try decodeServer(call)
            client.connect(server) { result in
                switch result {
                case .success(let value): call.resolve(self.encode(value))
                case .failure(let error): self.reject(call, error)
                }
            }
        } catch { reject(call, error) }
    }

    @objc public func disconnect(_ call: CAPPluginCall) {
        guard let id = call.getString("serverId") else { call.reject("Missing serverId", "INVALID_ARGUMENT"); return }
        client.disconnect(serverID: id)
        call.resolve()
    }

    @objc public func listTools(_ call: CAPPluginCall) {
        guard let id = call.getString("serverId") else { call.reject("Missing serverId", "INVALID_ARGUMENT"); return }
        let operationID = call.getString("operationId") ?? UUID().uuidString.lowercased()
        client.listTools(serverID: id, operationID: operationID) { result in
            switch result {
            case .success(let tools):
                // A successful tools/list that yields zero tools is a real
                // diagnostic state, not "everything is fine": the session is
                // ready but nothing is registered. Surface it explicitly so
                // the admin/Ombre adapter can report "no tools discovered"
                // instead of a generic degraded/empty state.
                var payload: [String: Any] = ["operationId": operationID, "tools": tools]
                if tools.isEmpty {
                    payload["noToolsDiscovered"] = true
                    payload["detail"] = "MCP server is connected but tools/list returned 0 tools"
                }
                call.resolve(payload)
            case .failure(let error): self.reject(call, error)
            }
        }
    }

    @objc public func callTool(_ call: CAPPluginCall) {
        guard let id = call.getString("serverId"), let name = call.getString("name") else { call.reject("Missing serverId or name", "INVALID_ARGUMENT"); return }
        let arguments = (call.getObject("arguments") ?? [:]).reduce(into: [String: Any]()) { $0[$1.key] = $1.value }
        let operationID = call.getString("operationId") ?? UUID().uuidString.lowercased()
        client.callTool(serverID: id, name: name, arguments: arguments, operationID: operationID) { result in
            switch result {
            case .success(var payload): payload["operationId"] = operationID; call.resolve(payload)
            case .failure(let error): self.reject(call, error)
            }
        }
    }

    @objc public func cancel(_ call: CAPPluginCall) {
        guard let serverID = call.getString("serverId"), let operationID = call.getString("operationId") else { call.reject("Missing serverId or operationId", "INVALID_ARGUMENT"); return }
        call.resolve(["cancelled": client.cancel(serverID: serverID, operationID: operationID)])
    }

    private func decodeServer(_ call: CAPPluginCall) throws -> SOOYAMcpServerConfiguration {
        guard call.getString("transport")?.lowercased() != "stdio" else { throw SOOYAMcpError.unsupportedTransport }
        guard let id = call.getString("serverId"), let rawURL = call.getString("url"), let url = URL(string: rawURL) else { throw SOOYAMcpError.invalidResponse }
        let authType = call.getString("authType") ?? "none"
        let reference = call.getString("tokenRef") ?? ""
        let auth: SOOYAMcpAuth
        switch authType {
        case "none": auth = .none
        case "bearer": auth = .bearer(tokenReference: reference)
        case "oauth": auth = .oauth(tokenReference: reference)
        default: throw SOOYAMcpError.invalidResponse
        }
        return .init(id: id, url: url, auth: auth, timeout: Double(call.getInt("timeoutMs") ?? 30_000) / 1_000)
    }

    private func encode(_ value: SOOYAMcpServerSnapshot) -> PluginCallResultData {
        ["serverId": value.id, "mode": value.mode.rawValue, "endpoint": value.endpoint.absoluteString, "sessionId": value.sessionID.map { $0 as Any } ?? NSNull(), "protocolVersion": value.protocolVersion]
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        call.reject(error.localizedDescription, String(describing: error), error)
    }
}
