import Foundation

// 試作専用。候補は既存の実 API から取り、時計と OS 受け口だけを差し替える。
// 本実装の原子的な取得・配信状態は DB に置く。この試作の Set はその代用ではない。
struct ReminderCandidate: Decodable {
    struct DataFields: Decodable { let note: String? }
    let id: Int
    let kind: String
    let issueId: String
    let issueTitle: String
    let createdAt: String
    let readAt: String?
    let data: DataFields
}

struct ProbeNotification: Codable {
    let issueId: String
    let notificationId: Int
    let title: String
    let body: String
}

final class ProbeDelivery {
    var claimed: Set<Int>
    let enabledAt: String
    let clock: () -> String
    let claim: (Set<Int>) throws -> Void
    let send: (ProbeNotification) -> Void

    init(enabledAt: String, claimed: Set<Int> = [], clock: @escaping () -> String,
         claim: @escaping (Set<Int>) throws -> Void, send: @escaping (ProbeNotification) -> Void) {
        self.enabledAt = enabledAt
        self.claimed = claimed
        self.clock = clock
        self.claim = claim
        self.send = send
    }

    func deliver(_ candidates: [ReminderCandidate]) throws {
        let now = clock()
        for item in candidates.sorted(by: { $0.createdAt < $1.createdAt || ($0.createdAt == $1.createdAt && $0.id < $1.id) }) {
            guard item.kind == "reminder", item.readAt == nil,
                  item.createdAt > enabledAt, item.createdAt <= now, !claimed.contains(item.id) else { continue }
            let next = claimed.union([item.id])
            try claim(next)
            claimed = next
            send(ProbeNotification(issueId: item.issueId, notificationId: item.id,
                                   title: item.issueTitle, body: item.data.note ?? "リマインダーの時刻になりました"))
        }
    }
}
