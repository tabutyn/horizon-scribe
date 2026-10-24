import Foundation
import HorizonScribeCore

struct HorizonScribeCloudAPI {
    private let baseURL: URL
    private let token: String
    private let decoder = JSONDecoder()

    init(baseURL: URL, token: String) {
        self.baseURL = baseURL
        self.token = token
    }

    func catalog() async throws -> HorizonScribeCatalog {
        try await get(["v1", "catalog"], as: HorizonScribeCatalog.self)
    }

    func imageState(datasetID: String, setID: String, imageName: String) async throws -> CloudReviewState {
        try await get(["v1", "sets", setID, "images", imageName], datasetID: datasetID, as: CloudReviewState.self)
    }

    func asset(datasetID: String, setID: String, imageName: String, artifact: String) async throws -> Data {
        guard ["photo", "baseMask", "classMask"].contains(artifact) else {
            throw HorizonScribeIdentityError.message("Unsupported HorizonScribe asset type.")
        }
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.percentEncodedPath = "/v1/asset"
        components?.queryItems = [
            URLQueryItem(name: "dataset", value: datasetID),
            URLQueryItem(name: "set", value: setID),
            URLQueryItem(name: "image", value: imageName),
            URLQueryItem(name: "artifact", value: artifact),
        ]
        guard let url = components?.url else { throw HorizonScribeIdentityError.message("Could not build asset URL.") }
        var request = makeRequest(url: url)
        request.httpMethod = "GET"
        let (data, response) = try await URLSession.shared.data(for: request)
        try requireSuccess(response, data: data)
        return data
    }

    func save(datasetID: String, setID: String, imageName: String, edit: CloudReviewEdit) async throws -> CloudReviewState {
        var request = makeRequest(path: ["v1", "sets", setID, "images", imageName], datasetID: datasetID)
        request.httpMethod = "PUT"
        request.httpBody = try JSONEncoder().encode(edit)
        let (data, response) = try await URLSession.shared.data(for: request)
        try requireSuccess(response, data: data)
        return try decoder.decode(CloudReviewState.self, from: data)
    }

    private func get<Response: Decodable>(_ path: [String], datasetID: String? = nil, as type: Response.Type) async throws -> Response {
        var request = makeRequest(path: path, datasetID: datasetID)
        request.httpMethod = "GET"
        let (data, response) = try await URLSession.shared.data(for: request)
        try requireSuccess(response, data: data)
        return try decoder.decode(type, from: data)
    }

    private func makeRequest(path: [String], datasetID: String? = nil) -> URLRequest {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        let encodedPath = path.map { component in
            component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))) ?? component
        }.joined(separator: "/")
        components?.percentEncodedPath = "/" + encodedPath
        if let datasetID { components?.queryItems = [URLQueryItem(name: "dataset", value: datasetID)] }
        return makeRequest(url: components?.url ?? baseURL)
    }

    private func makeRequest(url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    private func requireSuccess(_ response: URLResponse, data: Data) throws {
        guard let response = response as? HTTPURLResponse else {
            throw HorizonScribeIdentityError.message("HorizonScribe asset worker returned an invalid response.")
        }
        guard (200..<300).contains(response.statusCode) else {
            let failure = try? decoder.decode(ServerError.self, from: data)
            throw HorizonScribeIdentityError.httpStatus(response.statusCode, failure?.error)
        }
    }
}
