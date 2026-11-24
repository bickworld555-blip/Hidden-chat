package io.github.bickworld555.hiddenchat

import android.content.Context
import coil.ImageLoader
import okhttp3.OkHttpClient

/**
 * Image loading for the native UI (Step 5). Avatars (and later media) are served by the account's server behind the
 * session token, so a Coil [ImageLoader] carries an OkHttp interceptor that adds `Authorization: Bearer <token>` — the
 * same auth the WebView uses. Paths are resolved against the session origin, like [NativeServer]. In the root package
 * so it can read the package-private [RelaySession].
 */
object NativeImage {
    @Volatile private var loader: ImageLoader? = null

    /** The process-wide authenticated image loader. */
    fun loader(context: Context): ImageLoader {
        loader?.let { return it }
        synchronized(this) {
            loader?.let { return it }
            val app = context.applicationContext
            val client = OkHttpClient.Builder()
                .addInterceptor { chain ->
                    val token = RelaySession.read(app)?.token
                    val request = if (token.isNullOrEmpty()) chain.request()
                    else chain.request().newBuilder().header("Authorization", "Bearer $token").build()
                    chain.proceed(request)
                }
                .build()
            return ImageLoader.Builder(app)
                .okHttpClient(client)
                .crossfade(true)
                .build()
                .also { loader = it }
        }
    }

    /** The full URL for an avatar/media path (relative to the session origin), or null when there is none to load. */
    fun url(context: Context, path: String?): String? {
        if (path.isNullOrEmpty()) return null
        if (path.startsWith("http", ignoreCase = true) || path.startsWith("data:")) return path
        val origin = RelaySession.read(context.applicationContext)?.origin ?: return null
        return if (path.startsWith("/")) origin + path else "$origin/$path"
    }
}
