import Foundation
import Capacitor

/// Thin native WebSocket transport. Framing and application protocol remain in
/// TypeScript; this bridge only owns the long-lived socket and cancellation.
@objc(SOOYAWebSocketPlugin)
public final class SOOYAWebSocketPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionWebSocketDelegate {
    public let identifier = "SOOYAWebSocketPlugin"
    public let jsName = "SOOYAWebSocket"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abort", returnType: CAPPluginReturnPromise)
    ]

    private let lock = NSLock()
    private var sockets: [String: URLSessionWebSocketTask] = [:]
    private lazy var session: URLSession = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: OperationQueue())
    private lazy var secretStore = SOOYAKeychainStore()

    @objc public func connect(_ call: CAPPluginCall) {
        do {
            guard let rawURL = call.getString("url"), let url = URL(string: rawURL), url.scheme?.lowercased() == "wss", url.host != nil else { throw WebSocketError.invalidURL }
            let id = call.getString("id") ?? UUID().uuidString.lowercased()
            var request = URLRequest(url: url)
            if let secretRef = call.getString("secretRef"), !secretRef.isEmpty {
                guard let secret = try secretStore.read(key: secretRef), !secret.isEmpty else { throw WebSocketError.secretUnavailable }
                request.setValue((call.getString("secretPrefix") ?? "Bearer ") + secret, forHTTPHeaderField: call.getString("secretHeader") ?? "Authorization")
            }
            let task = session.webSocketTask(with: request)
            lock.lock(); defer { lock.unlock() }
            guard sockets[id] == nil else { throw WebSocketError.duplicateID }
            sockets[id] = task
            task.resume()
            call.resolve(["id": id])
            receive(id: id, task: task)
        } catch let error as WebSocketError { call.reject(error.localizedDescription, error.code) }
        catch { call.reject("WebSocket connection failed", "WEBSOCKET_CONNECT_FAILED") }
    }

    @objc public func send(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let task = socket(id) else { call.reject("Socket is not connected", "WEBSOCKET_NOT_CONNECTED"); return }
        let message: URLSessionWebSocketTask.Message
        if let text = call.getString("text") { message = .string(text) }
        else if let base64 = call.getString("dataBase64"), let data = Data(base64Encoded: base64) { message = .data(data) }
        else { call.reject("A text or dataBase64 payload is required", "WEBSOCKET_INVALID_PAYLOAD"); return }
        task.send(message) { error in
            if let error { call.reject(error.localizedDescription, "WEBSOCKET_SEND_FAILED") }
            else { call.resolve(["sent": true]) }
        }
    }

    @objc public func close(_ call: CAPPluginCall) { finish(call, code: .normalClosure, reason: "closed") }
    @objc public func abort(_ call: CAPPluginCall) { finish(call, code: .goingAway, reason: "aborted") }

    private func finish(_ call: CAPPluginCall, code: URLSessionWebSocketTask.CloseCode, reason: String) {
        guard let id = call.getString("id"), let task = removeSocket(id) else { call.resolve(["closed": false]); return }
        task.cancel(with: code, reason: reason.data(using: .utf8))
        notifyListeners("close", data: ["id": id, "reason": reason])
        call.resolve(["closed": true])
    }

    private func socket(_ id: String) -> URLSessionWebSocketTask? { lock.lock(); defer { lock.unlock() }; return sockets[id] }
    private func removeSocket(_ id: String) -> URLSessionWebSocketTask? { lock.lock(); defer { lock.unlock() }; return sockets.removeValue(forKey: id) }

    private func receive(id: String, task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text): self.notifyListeners("message", data: ["id": id, "text": text])
                case .data(let data): self.notifyListeners("message", data: ["id": id, "dataBase64": data.base64EncodedString()])
                @unknown default: break
                }
                if self.socket(id) != nil { self.receive(id: id, task: task) }
            case .failure(let error):
                _ = self.removeSocket(id)
                self.notifyListeners("error", data: ["id": id, "message": error.localizedDescription])
                self.notifyListeners("close", data: ["id": id, "reason": "receive_failed"])
            }
        }
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        if let id = socketID(webSocketTask) { notifyListeners("open", data: ["id": id, "protocol": `protocol` ?? ""]) }
    }

    private func socketID(_ task: URLSessionWebSocketTask) -> String? { lock.lock(); defer { lock.unlock() }; return sockets.first(where: { $0.value === task })?.key }
}

private enum WebSocketError: Error, LocalizedError {
    case invalidURL, duplicateID, secretUnavailable
    var code: String { switch self { case .invalidURL: return "WEBSOCKET_INVALID_URL"; case .duplicateID: return "WEBSOCKET_DUPLICATE_ID"; case .secretUnavailable: return "WEBSOCKET_SECRET_UNAVAILABLE" } }
    var errorDescription: String? { code }
}
