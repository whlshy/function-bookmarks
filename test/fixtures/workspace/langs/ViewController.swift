import UIKit

final class ViewController: UIViewController {
    init(model: Model) {
        super.init(nibName: nil, bundle: nil)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
    }
}

extension ViewController: UITableViewDelegate {
    func tableView(_ t: UITableView, didSelectRowAt i: IndexPath) {}
}

struct Point {
    mutating func move() {}
}

func helper() -> Int { 1 }
