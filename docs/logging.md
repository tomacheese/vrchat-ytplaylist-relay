# Reading the Logs

The server and `pnpm refresh` write JSON Lines to stdout / stderr. One line is one event. The service does not save logs to files or send them to external log services.

## Common fields

| Field                       | Description                                                                       |
| --------------------------- | --------------------------------------------------------------------------------- |
| `timestamp`                 | UTC time at which the event was recorded                                          |
| `level`                     | `info`, `warn`, or `error`                                                        |
| `event`                     | Searchable event name. Example: `http.request.completed`                          |
| `message`                   | Short description                                                                 |
| `request_id`                | HTTP request ID. Same value as the `X-Request-Id` response header                 |
| `operation`, `operation_id` | Kind of asynchronous operation and its correlation ID. Emitted only when relevant |
| `duration_ms`               | Processing time. Emitted on completion events of measured operations              |
| `error`                     | Failure type and message. Includes stack, code, and stderr when available         |

Depending on the event, `playlist_id`, `video_id`, `status_code`, `mode`, `track_count`, `size_bytes`, and others are also recorded. `info` goes to stdout; `warn` and `error` go to stderr.

## Tracing an HTTP request

Each request gets a random ID, and the same ID is attached to the logs and returned in the `X-Request-Id` response header. Use it to search for the request and for the refresh or delivery work it triggered.

`http.request.completed` records the method, route template, HTTP status, and duration. A route that cannot be resolved is recorded as `unmatched`, and the request path is not recorded. If the connection closes before processing finishes, `http.request.aborted` is emitted.

Normal success logs for `GET /health` and the relay segment routes are suppressed. Failed responses are logged: 4xx as `warn`, 5xx as `error`.

```bash
docker logs vrchat-ytplaylist-relay 2>&1 | grep '"request_id":"<X-Request-Id>"'
docker logs vrchat-ytplaylist-relay 2>&1 | grep '"event":"http.request.completed"'
```

## Commonly used events

| Event                                                    | Meaning                                                |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `playlist.refresh.completed` / `playlist.refresh.failed` | Playlist fetch and position state update               |
| `playlist.refresh.cache_served`                          | The in-memory manifest was returned                    |
| `playlist.refresh.failure_record_failed`                 | Persisting the refresh failure information failed      |
| `media.delivery.completed` / `media.delivery.failed`     | Result of a media delivery request                     |
| `media.delivery.fallback`                                | Switched from relay or similar to a different response |
| `media.cache.downloaded` / `media.cache.download_failed` | VOD download result                                    |
| `media.cache.evicted`                                    | Cache entries were deleted to free capacity            |
| `relay.live.lifecycle.*`                                 | Start, end, and failure of Live HLS republishing       |
| `relay.vod.*`                                            | VOD HLS preparation, segment creation, and cleanup     |
| `ytdlp.operation.failed`                                 | A yt-dlp invocation failed                             |

Event names are a classification that follows the implementation. The emitted fields vary by event. For example, `media.delivery.completed` includes the delivery mode, whether the video is Live, the HTTP status, and the duration.

## Sensitive information

The logger redacts known field names such as Authorization, Cookie, token, and signature. URL userinfo, query values, fragments, and Bearer tokens are also sanitized. `message`, `stack`, and `stderr` are kept up to 4,096 characters, and the excess is replaced with a truncation marker. Newlines and control characters are escaped inside JSON strings.

This protection covers known formats only. It cannot be guaranteed to detect unknown secrets. Do not pass Authorization headers, environment variables, full URLs, video titles, or similar values to log fields.
