import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Arrays;
import java.util.UUID;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.exception.SdkClientException;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.S3Exception;

class ObjectStorageProbe {
    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            throw new IllegalArgumentException("Expected a source fixture path");
        }
        URI endpoint = URI.create(variable("QA_S3_ENDPOINT"));
        String bucket = variable("QA_S3_BUCKET");
        String key = "qa/" + UUID.randomUUID() + ".txt";
        byte[] fixture = Files.readAllBytes(Path.of(args[0]));
        AwsBasicCredentials credentials =
                AwsBasicCredentials.create(variable("QA_S3_ACCESS_KEY"), variable("QA_S3_SECRET_KEY"));

        try (S3Client s3 = S3Client.builder()
                .endpointOverride(endpoint)
                .region(Region.US_EAST_1)
                .credentialsProvider(StaticCredentialsProvider.create(credentials))
                .serviceConfiguration(S3Configuration.builder()
                        .pathStyleAccessEnabled(true)
                        .chunkedEncodingEnabled(false)
                        .build())
                .overrideConfiguration(config -> config
                        .apiCallTimeout(Duration.ofSeconds(5))
                        .apiCallAttemptTimeout(Duration.ofSeconds(3)))
                .build()) {
            awaitBucket(s3, bucket);
            s3.putObject(request -> request.bucket(bucket).key(key).contentType("text/plain"),
                    RequestBody.fromBytes(fixture));
            try {
                byte[] downloaded = s3.getObjectAsBytes(request -> request.bucket(bucket).key(key)).asByteArray();
                if (!Arrays.equals(fixture, downloaded)) {
                    throw new IOException("The downloaded object does not match the source fixture");
                }
                HttpRequest request = HttpRequest.newBuilder(endpoint.resolve("/" + bucket + "/" + key))
                        .timeout(Duration.ofSeconds(5)).GET().build();
                int status = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.discarding())
                        .statusCode();
                if (status != 401 && status != 403) {
                    throw new IOException("Expected anonymous object access to be rejected, got HTTP " + status);
                }
            } finally {
                s3.deleteObject(request -> request.bucket(bucket).key(key));
            }
        }
        System.out.println("Private object store upload, download, and anonymous-access checks passed");
    }

    private static void awaitBucket(S3Client s3, String bucket) throws InterruptedException {
        for (int attempt = 0; ; attempt++) {
            try {
                s3.headBucket(request -> request.bucket(bucket));
                return;
            } catch (SdkClientException exception) {
                if (attempt == 7) throw exception;
            } catch (S3Exception exception) {
                if (attempt == 7 || (exception.statusCode() != 404 && exception.statusCode() < 500)) {
                    throw exception;
                }
            }
            Thread.sleep(1000);
        }
    }

    private static String variable(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Missing environment variable " + name);
        }
        return value;
    }
}
