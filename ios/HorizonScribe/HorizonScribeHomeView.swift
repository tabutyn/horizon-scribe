import SwiftUI

struct HorizonScribeHomeView: View {
    @EnvironmentObject private var session: HorizonScribeSession
    @State private var workerURL = ""
    @State private var apiToken = ""

    var body: some View {
        ZStack {
            Color.horizonScribeBackground.ignoresSafeArea()
            if session.catalog != nil { HorizonScribeWorkspaceView() }
            else { signInGate }
        }
        .tint(Color.horizonScribeLime)
    }

    private var signInGate: some View {
        VStack(spacing: 18) {
            Spacer()
            Text("HorizonScribe")
                .font(.system(size: 42, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            Text("Your photos. Your Cloudflare account.")
                .font(.title3)
                .foregroundStyle(Color.horizonScribeMuted)
            ProgressView()
                .tint(Color.horizonScribeLime)
                .opacity(session.isBusy ? 1 : 0)
            Text(session.status)
                .font(.callout)
                .foregroundStyle(Color.horizonScribeMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 500)
            if session.isSignedIn {
                HStack(spacing: 12) {
                    Button("Retry") { Task { await session.refreshAccess() } }
                        .buttonStyle(HorizonScribePrimaryButtonStyle())
                    Button("Forget connection", role: .destructive) { Task { await session.signOut() } }
                        .buttonStyle(HorizonScribeQuietButtonStyle())
                }
            } else {
                VStack(spacing: 12) {
                    TextField("https://your-worker.workers.dev", text: $workerURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)
                    SecureField("API token", text: $apiToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)
                    Button {
                        Task { await session.connect(workerURL: workerURL, apiToken: apiToken) }
                    } label: {
                        Text(session.isBusy ? "Connecting…" : "Connect")
                            .frame(minWidth: 220)
                    }
                    .buttonStyle(HorizonScribePrimaryButtonStyle())
                    .disabled(session.isBusy || workerURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || apiToken.isEmpty)
                }
                .frame(maxWidth: 560)
            }
            Spacer()
            Text("Next Pass photos are kept on this iPad for offline review.")
                .font(.footnote)
                .foregroundStyle(Color.horizonScribeMuted)
        }
        .padding(32)
    }

}

extension Color {
    static let horizonScribeBackground = Color(red: 0.027, green: 0.067, blue: 0.059)
    static let horizonScribePanel = Color(red: 0.051, green: 0.098, blue: 0.086)
    static let horizonScribeLine = Color(red: 0.149, green: 0.231, blue: 0.204)
    static let horizonScribeMuted = Color(red: 0.569, green: 0.667, blue: 0.631)
    static let horizonScribeLime = Color(red: 0.847, green: 1.0, blue: 0.349)
    static let horizonScribeSea = Color(red: 0.129, green: 0.831, blue: 0.816)
    static let horizonScribeSky = Color(red: 0.612, green: 0.514, blue: 1.0)
    static let horizonScribeLand = Color(red: 0.490, green: 1.0, blue: 0.573)
}

struct HorizonScribePrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .fontWeight(.bold)
            .foregroundStyle(Color(red: 0.063, green: 0.078, blue: 0.043))
            .padding(.horizontal, 18)
            .frame(minHeight: 46)
            .background(Color.horizonScribeLime.opacity(configuration.isPressed ? 0.78 : 1))
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct HorizonScribeQuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .fontWeight(.semibold)
            .foregroundStyle(configuration.isPressed ? Color.horizonScribeLime : .white)
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(Color.horizonScribePanel)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.horizonScribeLine))
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}
