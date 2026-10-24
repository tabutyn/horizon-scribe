// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HorizonScribeCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "HorizonScribeCore", targets: ["HorizonScribeCore"])],
    targets: [
        .target(name: "HorizonScribeCore"),
        .testTarget(name: "HorizonScribeCoreTests", dependencies: ["HorizonScribeCore"])
    ]
)
