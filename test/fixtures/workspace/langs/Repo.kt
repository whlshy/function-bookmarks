data class User(val name: String)

class Repo(private val db: Db) {
    suspend fun load(id: Long): User? {
        return db.find(id)
    }

    fun <T> List<T>.second(): T = this[1]

    companion object {
        fun create(): Repo = Repo(Db())
    }
}

fun main() {
    println("fun fake() {")
}
