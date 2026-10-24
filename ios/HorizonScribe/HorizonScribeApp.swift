import SwiftUI

@main
struct HorizonScribeApp: App {
    @StateObject private var session = HorizonScribeSession()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            HorizonScribeHomeView()
                .environmentObject(session)
                .preferredColorScheme(.dark)
                .task { await session.restoreSession() }
                .onChange(of: scenePhase) { phase in
                    if phase != .active { Task { await session.persistCurrentDraft() } }
                }
        }
    }
}
