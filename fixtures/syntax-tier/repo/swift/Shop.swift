import Foundation
import struct Billing.Invoice

protocol Pricing {
    var currency: String { get }
    func price(of item: String) -> Int
}

struct Catalog: Pricing {
    let currency = "EUR"
    func price(of item: String) -> Int {
        return lookup(item)
    }
}

class Cart {
    static let shared = Cart()
    var items: [String] = []
    func add(_ item: String) {
        items.append(item)
        notify(item)
    }
}

enum Size {
    case small, large
    func label() -> String { describe(self) }
}

extension Cart {
    func clear() { items.removeAll() }
}

func lookup(_ item: String) -> Int { item.count }
