import lock from "../posthog.lock.json";
import { clickhouseBuildProvenance, clickhouseCandidateTag } from "./lib/clickhouse-build";

const build = clickhouseBuildProvenance(lock);
console.log(`clickhouse_base_image=${build.baseImage}`);
console.log(`clickhouse_base_version=${build.baseVersion}`);
console.log(`clickhouse_build_sha256=${build.fingerprintSha256}`);
console.log(`clickhouse_tag=${clickhouseCandidateTag(lock)}`);
