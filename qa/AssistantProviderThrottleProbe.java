package top.continew.admin.assistant.model;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import top.continew.admin.assistant.account.AssistantApiException;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public class AssistantProviderThrottleProbe {
    public static void main(String[] args) throws Exception {
        var requests = new AtomicInteger();
        var deltas = new AtomicInteger();
        var listener = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 0);
        var deadlines = Executors.newSingleThreadScheduledExecutor();
        listener.createContext("/synthetic/completions", exchange -> {
            try (exchange) {
                if (!exchange.getRequestMethod().equals("POST")) {
                    exchange.sendResponseHeaders(405, -1);
                    return;
                }
                requests.incrementAndGet();
                exchange.getResponseHeaders().set("Retry-After", "1");
                exchange.sendResponseHeaders(429, -1);
            }
        });
        listener.start();
        try {
            var endpoint = URI.create("http://127.0.0.1:" + listener.getAddress().getPort() + "/synthetic/completions");
            var http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2))
                .followRedirects(HttpClient.Redirect.NEVER).build();
            var provider = new OpenAiTextProvider(http, new ObjectMapper(), deadlines, endpoint,
                "synthetic-throttle", "fixture-only");
            try {
                provider.generate(List.of(new AssistantModels.Turn("user", "synthetic input")),
                    delta -> deltas.incrementAndGet());
                throw new AssertionError("Expected the provider adapter to reject a throttled response");
            } catch (AssistantApiException error) {
                if (error.status().value() != 429 || !"RATE_LIMITED".equals(error.code())
                    || requests.get() != 1 || deltas.get() != 0) {
                    throw new AssertionError("Throttling must map to RATE_LIMITED without output or an immediate retry");
                }
            }
            System.out.println("{\"suite\":\"assistant-provider-throttle\",\"status\":\"passed\","
                + "\"providerHttpStatus\":429,\"code\":\"RATE_LIMITED\",\"requests\":1,\"deltas\":0}");
        } finally {
            listener.stop(0);
            deadlines.shutdownNow();
        }
    }
}
