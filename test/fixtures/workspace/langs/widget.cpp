namespace app {
namespace detail {
template <typename T>
T clamp(T v, T lo, T hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}
}  // namespace detail

class Widget : public QObject {
    Q_OBJECT
public:
    explicit Widget(QObject *parent = nullptr) : QObject(parent) {
    }
    ~Widget() override {}
    int size() const { return size_; }
    void paint(Painter &p) override;
    static std::unique_ptr<Widget> create();
private:
    int size_ = 0;
};

void Widget::paint(Painter &p) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto draw = [&](int x) { p.draw(x); };
    R"(void raw_not_me() {)";
}

std::unique_ptr<Widget> Widget::create() {
    return std::make_unique<Widget>();
}

const std::string& Config::name() const noexcept {
    return name_;
}

Config::Config(int v) : value_(v) {
}

bool operator==(const Config &a, const Config &b) {
    return a.value_ == b.value_;
}

enum class Mode : int { Fast, Slow };
}  // namespace app
