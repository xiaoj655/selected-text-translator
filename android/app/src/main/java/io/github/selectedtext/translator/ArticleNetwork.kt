package io.github.selectedtext.translator

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import java.net.InetAddress
import java.net.UnknownHostException
import okhttp3.Dns
import okhttp3.OkHttpClient

internal class ArticleNetwork(context: Context) {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val clients = mutableMapOf<OkHttpClient, Pair<Network, OkHttpClient>>()

    fun client(base: OkHttpClient): OkHttpClient {
        val network = activeVpn() ?: return base
        synchronized(clients) {
            clients[base]?.takeIf { it.first == network }?.let { return it.second }
            val vpnClient = base.newBuilder()
                .socketFactory(network.socketFactory)
                .dns(object : Dns {
                    override fun lookup(hostname: String): List<InetAddress> =
                        network.getAllByName(hostname)
                            .filter { isPublicArticleAddress(it) || isVpnFakeIp(it) }
                            .ifEmpty { throw UnknownHostException("The VPN returned no public address for this site.") }
                            .toList()
                })
                .build()
            clients[base] = network to vpnClient
            return vpnClient
        }
    }

    private fun activeVpn(): Network? {
        val network = connectivity.activeNetwork ?: return null
        return network.takeIf {
            connectivity.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
        }
    }
}

internal fun isVpnFakeIp(address: InetAddress): Boolean {
    val bytes = address.address
    return bytes.size == 4 &&
        (bytes[0].toInt() and 0xff) == 198 &&
        (bytes[1].toInt() and 0xff) in 18..19
}
