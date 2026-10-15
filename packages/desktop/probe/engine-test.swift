import Foundation

@main
struct ProbeEngineTest {
    static func main() throws {
        let candidates = try JSONDecoder().decode([ReminderCandidate].self, from: FileHandle.standardInput.readDataToEndOfFile())
        var sent: [ProbeNotification] = []
        let delivery = ProbeDelivery(enabledAt: "2030-01-01T00:00:00.000Z", clock: { "2030-01-01T00:00:03.000Z" },
                                     claim: { _ in }, send: { sent.append($0) })
        try delivery.deliver(candidates)
        try delivery.deliver(candidates)
        FileHandle.standardOutput.write(try JSONEncoder().encode(sent))
    }
}
