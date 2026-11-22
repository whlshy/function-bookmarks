package com.example;

@Service
public class UserService extends Base implements Api {
    private final UserRepo repo;
    private Runnable task = new Runnable() {
        public void run() {}
    };

    public UserService(UserRepo repo) {
        this.repo = repo;
    }

    @Override
    public List<User> findAll(int page, int size) throws IOException {
        if (page < 0) {
            throw new IllegalArgumentException("page {");
        }
        return repo.findAll();
    }

    public static <T> Map<String, List<T>> group(
            Collection<T> items,
            Function<T, String> key) {
        return null;
    }

    abstract void hook();

    String text() {
        return """
            void notMe() {
            """;
    }

    enum Status { ACTIVE, INACTIVE }

    record Pair(String a, String b) {}
}
