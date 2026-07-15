"""Generate all seed data and test case JSONL files for crossroad-trainer."""
from __future__ import annotations
import json
import os

BASE = os.path.expanduser("~/.mycc-store/crossroad-trainer")
DATA = os.path.join(BASE, "data")
TESTS = os.path.join(BASE, "tests", "test_cases")

os.makedirs(DATA, exist_ok=True)
os.makedirs(os.path.join(TESTS, "en"), exist_ok=True)
os.makedirs(os.path.join(TESTS, "zh"), exist_ok=True)

def wj(path: str, samples: list[dict]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    print(f"Wrote {len(samples)} samples to {path}")

# ── helpers ──
def pos(text: str, idx: int) -> dict:
    return {"text": text, "turnIndex": idx, "label": 1}

def neg(text: str) -> dict:
    return {"text": text, "label": 0}

def find_idx(text: str, word: str) -> int:
    return text.index(word)

# ════════════════════════════════════════════════════════════
# SEED POSITIVE (~200)
# ════════════════════════════════════════════════════════════
positives: list[dict] = []

# English Tier 1 strong signals
en_t1 = [
    ("I think we should use approach A because it is simpler and faster to implement. Having said that, we should consider the performance implications before committing.", "Having said that"),
    ("The caching strategy works well for most use cases and handles high traffic effectively. That being said, we should consider adding distributed caching for better scalability.", "That being said"),
    ("We could take the quick path and patch the existing code to handle this edge case. On the other hand, a more thorough refactoring would prevent similar issues from arising.", "On the other hand"),
    ("Let me check the authentication module first to understand the login flow. Hold on, I see the problem now -- it is in the token validation logic, not the login.", "Hold on"),
    ("直接重写整个模块是最彻底的解决方案，可以在短期内解决所有已知问题。话说回来，我们需要考虑重写过程中对其他模块的影响和回归风险。", "话说回来"),
    ("最简单的解决方案是直接修改配置文件，添加新的环境变量来覆盖默认值。等一下，这样可能会影响其他服务的配置，需要更谨慎地处理。", "等一下"),
    ("The current implementation is clean and follows best practices throughout the codebase. Having said that, there are some areas where we could improve error handling.", "Having said that"),
    ("I was going to recommend using the third-party library for this new feature. On second thought, we should build it ourselves to avoid the dependency overhead.", "On second thought"),
    ("The straightforward approach is to add a new column to the existing database table. Then again, a separate table would be more normalized and flexible long-term.", "Then again"),
    ("我们可以直接修改配置文件来快速解决这个环境变量的问题。话说回来，这样做可能会影响到其他依赖同一配置文件的服务模块。", "话说回来"),
    ("先用最简单的方式直接修复这个bug，添加一个空值检查就好了。等一下，根本原因其实是在数据层，空值是从那里产生的。", "等一下"),
]
for text, word in en_t1:
    positives.append(pos(text, find_idx(text, word)))

# English Tier 2 sentence-boundary
en_t2 = [
    ("I think we should use approach A because it is simpler and faster. However, let me reconsider the performance implications before committing.", "However"),
    ("The performance looks acceptable with the current dataset size in testing. However, under production load with ten times the data, we might see significant degradation.", "However"),
    ("The test coverage is quite comprehensive with over 90 percent line coverage. Nevertheless, there are some edge cases that are not covered by the current test suite.", "Nevertheless"),
    ("The initial design document outlines a microservices architecture for this system. Nonetheless, a monolithic approach might be more appropriate given our team size.", "Nonetheless"),
    ("The API is well-documented and follows REST conventions consistently throughout. That said, we might want to consider GraphQL for more flexible querying.", "That said"),
    ("I believe the bug is in the authentication module based on the error message. Actually, looking at the stack trace more carefully, the issue is in the database layer.", "Actually"),
    ("The refactoring approach is cleaner and more maintainable in the long run. But it requires significant upfront investment that we may not have time for right now.", "But"),
    ("The code passes all existing tests and the linter shows no warnings at all. Nevertheless, I want to add more integration tests to cover the edge cases we discussed.", "Nevertheless"),
    ("The REST API design is clean and follows conventional resource naming well. Nonetheless, we should consider adding pagination for the list endpoints to handle large datasets.", "Nonetheless"),
    ("I initially thought the problem was a memory leak in the application code. That said, after running the profiler, it turns out the issue is excessive garbage collection.", "That said"),
    ("Let me refactor this function to use async/await instead of raw callbacks. Actually, the callback pattern is fine here since the operations are simple and sequential.", "Actually"),
    ("We should implement the new feature using the existing utility functions first. But first, let me check if there is a library that already does this more efficiently.", "But"),
    ("The API response time is within acceptable limits for the current load level. Nevertheless, we should add caching headers to improve performance for repeated requests.", "Nevertheless"),
    ("The error handling is minimal but functional for the current use case overall. That said, we should implement a more robust retry mechanism with exponential backoff.", "That said"),
    ("The deployment script looks correct and should work in the staging environment. However, I notice we are missing environment variable validation for production.", "However"),
]
for text, word in en_t2:
    positives.append(pos(text, find_idx(text, word)))

# English Tier 3 special (Wait interjection)
en_t3 = [
    ("Let me just fix this bug by adding a null check before the function call. Wait, actually the root cause is in the data layer where the null values originate.", "Wait"),
    ("I will write a simple loop to iterate through all the items in the list. Wait, a recursive approach would be more elegant and handle nested structures better.", "Wait"),
    ("Let me start by fixing the import error in the main entry point file. Wait, the import is correct -- the actual issue is a missing dependency in the package file.", "Wait"),
    ("Let me write a regex pattern to validate the email address format string. Wait, I should use a proper validation library since regex for emails is notoriously unreliable.", "Wait"),
    ("Let me check if the API endpoint is returning the correct status code here. Wait, I am testing the wrong endpoint -- the actual route is registered under a different path.", "Wait"),
    ("Let me debug this by adding console log statements throughout the function. Wait, I should use the debugger instead for a more systematic approach to tracing.", "Wait"),
    ("The function takes two arguments and returns their sum as expected here. Wait, I need to handle the case where the inputs are not numbers -- let me add type checking.", "Wait"),
    ("Let me optimize this function by memoizing the expensive computation results. Wait, the function has side effects so memoization would break the expected behavior.", "Wait"),
    ("Let me fix the flaky test by adding a small delay before the assertion call. Wait, that is just masking the real issue -- I should find and fix the actual race condition.", "Wait"),
    ("Let me add a cache control header to the API response for performance. Wait, I need to be careful about caching authenticated responses -- it could leak data between users.", "Wait"),
    ("Let me check the database connection string in the configuration file now. Wait, the issue might be in the connection pool settings rather than the connection string itself.", "Wait"),
    ("Let me add a new index to the database table to speed up the query up. Wait, I should check the query plan first to confirm that the index would actually be used.", "Wait"),
    ("Let me check the network configuration to see if the port is open now. Wait, the firewall rules might be blocking the traffic -- I should check that first before anything.", "Wait"),
    ("Let me write a custom hook to manage the form state and validation logic. Wait, the existing form library handles all of this already with better edge case coverage.", "Wait"),
    ("Let me add a new index to the database to speed up the search query now. Wait, I should check the query execution plan first to see if an index would actually help.", "Wait"),
]
for text, word in en_t3:
    positives.append(pos(text, find_idx(text, word)))

# English coding context turns
en_coding = [
    ("I will use the map function to transform each element in the array now. Actually, a reduce would be better here since we need to accumulate a single value from the data.", "Actually"),
    ("I will create a new module to handle all the authentication logic separately. Actually, let me first check if there is an existing module I can extend instead of starting fresh.", "Actually"),
    ("I was planning to use Redis for caching the API responses in production. Hold on, let me check if the current infrastructure even supports Redis before committing to it.", "Hold on"),
    ("Let me add a try-catch block around the database query to handle errors. Actually, the ORM already handles exceptions internally, so this might be completely unnecessary.", "Actually"),
    ("I will use a simple polling mechanism to check for job completion status. Wait, a webhook callback would be more efficient than polling the API every few seconds repeatedly.", "Wait"),
    ("I will use a simple retry mechanism with three attempts for the HTTP request. Wait, we should use exponential backoff between retries to avoid overwhelming the server.", "Wait"),
    ("I will use the default serialization for the cache entries storing JSON strings. Wait, we should consider using a more compact format like MessagePack for large cache values.", "Wait"),
    ("I will use a simple string interpolation to build the SQL query dynamically. Wait, this is vulnerable to injection -- I must use parameterized queries instead of interpolation.", "Wait"),
    ("Let me add input validation to the public API endpoints for security reasons. Wait, the middleware already validates inputs before they reach the handler -- I should check there.", "Wait"),
    ("I will start by writing the test cases for the new feature before implementation. Actually, let me first review the requirements to make sure I understand the expected behavior.", "Actually"),
    ("Let me write a migration script to add the new column to the users table. Actually, I should also update the ORM model definition to include the new field properly.", "Actually"),
    ("I will use the default fetch implementation to make the HTTP requests to API. Wait, we should add a timeout wrapper since fetch does not have a built-in timeout mechanism.", "Wait"),
    ("Let me add a new interceptor to add the authentication header to requests. Wait, the existing interceptor already adds this -- I should check before adding a duplicate one.", "Wait"),
    ("I will create a new route handler to serve the static assets from server. Wait, the CDN should serve static assets directly -- the server should only handle API requests.", "Wait"),
    ("Let me add error boundaries to catch rendering errors in the component tree. Actually, the error boundary component is already implemented -- I just need to wrap the tree.", "Actually"),
]
for text, word in en_coding:
    positives.append(pos(text, find_idx(text, word)))

# English planning context turns
en_planning = [
    ("We should implement feature A first since it is the highest priority item. However, considering the deadline, maybe we should tackle the smaller features first instead.", "However"),
    ("We can deploy the new version with a simple blue-green deployment strategy. On second thought, a canary deployment would be safer given the scale of changes involved.", "On second thought"),
    ("We should schedule the database migration during the weekend maintenance window. On second thought, doing it during business hours would let us catch issues faster.", "On second thought"),
    ("The migration plan involves updating all services to the new API version. On the other hand, we could use a compatibility layer to avoid breaking existing clients.", "On the other hand"),
    ("We should use a message queue to decouple the producer and consumer services. Having said that, for our current scale, synchronous calls might be simpler and sufficient.", "Having said that"),
    ("We should deploy the service to the cloud using container orchestration tools. Having said that, a serverless deployment might be more cost-effective for this workload.", "Having said that"),
    ("We should implement the feature using the latest version of the framework. On the other hand, the previous version is more stable and better documented for our needs.", "On the other hand"),
    ("We should implement the caching at the service layer for business logic. Having said that, caching at the HTTP layer with proper headers might be simpler and sufficient.", "Having said that"),
    ("We should implement the feature using a simple CRUD interface for admin panel. That said, a more sophisticated UI with batch operations would improve the admin experience.", "That said"),
    ("We should implement the rate limiting at the API gateway level for consistency. Having said that, some services might need different rate limits based on their specific requirements.", "Having said that"),
    ("We should implement the feature toggle using a simple boolean flag variable. Having said that, a percentage-based rollout would allow gradual feature deployment safely.", "Having said that"),
    ("We should use a simple array to store the list of pending tasks in memory. That said, a proper task queue would persist tasks and survive application restarts gracefully.", "That said"),
    ("We should implement the feature using a simple event emitter pattern locally. That said, a more structured event bus would provide better type safety and decoupling.", "That said"),
    ("We should implement the feature using the repository pattern for data access. Having said that, an ORM with a good query builder might make the repository layer redundant.", "Having said that"),
    ("We should use a content delivery network to serve static assets globally. That being said, our current traffic does not justify the added complexity and cost just yet.", "That being said"),
]
for text, word in en_planning:
    positives.append(pos(text, find_idx(text, word)))

# Chinese turning words
zh_turns = [
    ("最简单的方案是直接修改数据库连接字符串，添加重试逻辑来处理网络波动。然而，这样只是治标不治本，根本问题在于连接池的配置不合理。", "然而"),
    ("直接重写整个模块是最彻底的解决方案，可以在短期内解决所有已知问题。话说回来，我们需要考虑重写过程中对其他模块的影响和回归风险。", "话说回来"),
    ("最简单的解决方案是直接修改配置文件，添加新的环境变量来覆盖默认值。等一下，这样可能会影响其他服务的配置，需要更谨慎地处理。", "等一下"),
    ("最简单的解决方案是直接修改配置文件，添加新的环境变量来覆盖默认值。等等，这样可能会影响其他服务的配置，需要更谨慎地处理。", "等等"),
    ("我先用最简单的方式修复这个bug，添加一个空值检查就好了。不对，根本原因其实是在数据层，空值是从那里产生的。", "不对"),
    ("我们可以直接修改配置文件来快速解决这个环境变量的问题。话说回来，这样做可能会影响到其他依赖同一配置文件的服务模块。", "话说回来"),
    ("先用最简单的方式直接修复这个bug，添加一个空值检查就好了。等一下，根本原因其实是在数据层，空值是从那里产生的。", "等一下"),
    ("我认为应该采用方案A，因为它更简单且实现速度更快。然而，考虑到性能影响，我们需要重新评估这个决策。", "然而"),
    ("这个方案的实现成本最低，可以快速上线给用户使用。不过，从长远来看，维护成本可能会超出我们的预算。", "不过"),
    ("直接使用第三方库可以节省大量开发时间，加快项目进度。其实，我们需要的功能很少，自己实现可能更合适。", "其实"),
    ("我们可以先实现核心功能，然后再逐步完善其他辅助功能。但是，如果核心功能本身设计有问题，后续修改成本会很高。", "但是"),
    ("这个模块的设计很清晰，代码结构也遵循了最佳实践。然而，错误处理方面还有改进的空间，需要更加统一。", "然而"),
    ("先用缓存来优化数据库查询性能，这是一个简单有效的方案。不过，如果数据更新频繁，缓存一致性会是个大问题。", "不过"),
    ("我们可以用简单的轮询机制来检查任务完成状态。其实，使用回调机制会更高效，不需要频繁请求API。", "其实"),
    ("直接修改数据库表结构是最快的解决方案，只需要加一个字段。但是，这样可能会导致已有数据出现兼容性问题。", "但是"),
    ("我们可以先用单元测试覆盖主要功能，确保基本逻辑正确。然而，集成测试也是必要的，需要测试组件之间的交互。", "然而"),
    ("使用环境变量来管理配置是最简单直接的方式。不过，随着配置项增多，这种方式会变得难以维护。", "不过"),
    ("先用简单的数组来存储用户会话列表就可以了。其实，用Set会更合适，因为我们需要唯一性和快速查找。", "其实"),
    ("我们可以先用同步调用来实现服务间通信，简化开发流程。但是，当并发量增大时，同步调用会成为性能瓶颈。", "但是"),
    ("这个测试用mock数据库来测试业务逻辑，速度快且结果稳定。然而，我们也需要用真实数据库做集成测试来验证端到端功能。", "然而"),
    ("先用简单的if-else来处理不同的请求类型就好了。不过，当类型越来越多时，策略模式会更易于扩展。", "不过"),
    ("我们可以先用控制台输出来记录日志信息。其实，应该使用结构化日志库来支持日志级别和格式化。", "其实"),
    ("直接在代码中写死配置参数是最快的做法。但是，这样会导致每次修改配置都需要重新部署应用。", "但是"),
    ("我们可以先用内存缓存来存储频繁访问的数据。然而，在多服务器环境下，内存缓存会导致数据不一致。", "然而"),
    ("先用简单的字符串匹配来实现搜索功能就可以了。不过，当数据量增大时，全文搜索引擎会更有优势。", "不过"),
]
for text, word in zh_turns:
    positives.append(pos(text, find_idx(text, word)))

# More English variety to reach ~200
en_more = [
    ("I will use environment variables to configure the service connection strings. Actually, a config file with validation would be more maintainable than scattered env vars.", "Actually"),
    ("The queue-based architecture handles async job processing very efficiently. On the other hand, a streaming approach might be better for real-time data pipelines.", "On the other hand"),
    ("I was going to add a new dependency for handling date formatting in the app. Hold on, the built-in Intl API should be sufficient for our use case without adding extra weight.", "Hold on"),
    ("I will implement the feature using the existing authentication middleware. That being said, we need to update the middleware to support the new token format too.", "That being said"),
    ("The code review found several issues with the error handling approach used. On the other hand, the core logic is sound and the issues are mostly cosmetic improvements.", "On the other hand"),
    ("Let me add a new field to the database schema to track user activity. On second thought, we should use a separate analytics service for this kind of tracking data.", "On second thought"),
    ("I will use the default serialization format which is JSON for all responses. Then again, Protocol Buffers would be more efficient for the high-throughput endpoints.", "Then again"),
    ("The integration tests pass consistently in the local development environment. Nevertheless, they sometimes fail in CI due to timing issues with the test database.", "Nevertheless"),
    ("I will write a custom validation function to check the input parameters. But the validation library we already use can handle this with a simple schema definition.", "But"),
    ("Let me start by adding logging statements to trace the execution flow. Actually, I should use the existing tracing infrastructure rather than adding ad-hoc log statements.", "Actually"),
    ("The build pipeline is configured to run tests and linting on every push. That said, we should also add a security scan step to check for known vulnerabilities.", "That said"),
    ("We should implement the caching layer using the built-in Map data structure. On the other hand, an LRU cache library would handle eviction automatically for us.", "On the other hand"),
    ("I was planning to store session data in memory for the web application. Having said that, this will not work with multiple server instances -- we need Redis or similar.", "Having said that"),
    ("The authentication uses JWT tokens with a standard expiration time of one hour. That being said, we should implement refresh tokens for better security and user experience.", "That being said"),
    ("I will handle the concurrent requests using a simple mutex lock mechanism. On the other hand, an optimistic concurrency approach would avoid locking and scale better.", "On the other hand"),
    ("Let me refactor the function to reduce its complexity and improve readability. On second thought, splitting it into smaller functions would make the flow harder to follow.", "On second thought"),
    ("The error message suggests a null pointer exception in the service layer. Then again, it could also be a deserialization issue if the input format changed recently.", "Then again"),
    ("I will create a new type for the configuration to make it strongly typed. Actually, we can use the existing type definitions and just extend them with the new fields.", "Actually"),
    ("The library documentation is comprehensive and includes many usage examples. Nevertheless, the API has changed significantly in the latest version without full migration guide.", "Nevertheless"),
    ("I will write a script to migrate the data from the old format to the new. But I should first backup the database before running any migration scripts in production.", "But"),
    ("The performance bottleneck is clearly in the database query execution layer. That said, optimizing the query alone will not help if the indexes are not properly configured.", "That said"),
    ("I will implement the retry logic using a simple loop with a fixed delay. On the other hand, exponential backoff with jitter would be more robust under high contention.", "On the other hand"),
    ("We should use a content delivery network to serve static assets globally. That being said, our current traffic does not justify the added complexity and cost yet.", "That being said"),
    ("The module exports a single function that handles all the processing logic. However, we should split it into smaller functions for better testability and maintainability.", "However"),
    ("I will use the default timeout value of thirty seconds for the HTTP request. Having said that, some of our endpoints need a longer timeout for processing large file uploads.", "Having said that"),
    ("The state management is handled using a simple useState hook in React. On the other hand, a state management library would be better for the complex nested state.", "On the other hand"),
    ("I will deploy the application using Docker containers on a virtual machine. Then again, Kubernetes would handle scaling and self-healing much better than manual deployment.", "Then again"),
    ("The test for the utility function covers the main use case and basic edge cases. Nevertheless, we should add property-based testing to catch edge cases we have not thought of.", "Nevertheless"),
    ("I will use the fetch API to make HTTP requests from the client application. But we should consider using a library with automatic retries and timeout handling.", "But"),
    ("The database schema is normalized to third normal form which is good practice. That said, some denormalization might improve query performance for the read-heavy endpoints.", "That said"),
    ("I will create a separate microservice to handle the notification delivery logic. On the other hand, integrating it into the existing service would reduce deployment complexity.", "On the other hand"),
    ("Let me implement the feature flag system using a simple configuration object. Actually, a dedicated feature flag service would allow toggling features without redeployment.", "Actually"),
    ("The API gateway routes requests to the appropriate backend service correctly. Having said that, we should add circuit breakers to prevent cascading failures downstream.", "Having said that"),
    ("I will use a simple string comparison to check if the values are equal. That being said, a deep equality check would be needed for comparing objects and arrays properly.", "That being said"),
    ("We should implement the logging using the built-in console functions for simplicity. On the other hand, a structured logging library would support log levels and formatting.", "On the other hand"),
    ("I was going to add CORS headers manually to each route handler. On second thought, using the CORS middleware would be cleaner and less error-prone than manual headers.", "On second thought"),
    ("The type definitions are correct and match the runtime structure of the data. Then again, we should add runtime validation since the data comes from an external API.", "Then again"),
    ("I will handle the file upload using a multipart form data parser library. Nevertheless, we should add file size limits and type validation to prevent abuse of the endpoint.", "Nevertheless"),
    ("Let me write a custom error class to represent the domain-specific errors. But the existing error hierarchy already has a similar class that I can just extend instead.", "But"),
    ("The code is well-structured with clear separation of concerns throughout. However, the error handling could be more consistent across the different modules and services.", "However"),
    ("We should use a message queue to decouple the producer and consumer services. Having said that, for our current scale, synchronous calls might be simpler and sufficient.", "Having said that"),
    ("The integration with the payment gateway is working correctly in testing. On the other hand, we should add idempotency keys to prevent duplicate charge issues.", "On the other hand"),
    ("Let me use a simple array to store the list of active user sessions. On second thought, a Set would be more appropriate since we need uniqueness and fast lookups.", "On second thought"),
    ("The unit tests mock the database calls to test the business logic in isolation. Nevertheless, we should add integration tests that use a real database for end-to-end validation.", "Nevertheless"),
    ("Let me add a new endpoint to expose the internal health check status. But the existing monitoring endpoint already provides this information in a more comprehensive format.", "But"),
    ("The authentication middleware validates the JWT token on every request. That said, we should cache the decoded token to avoid repeated verification overhead.", "That said"),
    ("Let me write a migration script to add the new column to the users table. Actually, I should also update the ORM model definition to include the new field properly.", "Actually"),
    ("We should store the API keys in environment variables for security reasons. On the other hand, a secrets management service would provide better rotation and audit capabilities.", "On the other hand"),
    ("I will implement the pagination using offset and limit parameters in the query. Having said that, cursor-based pagination would be more efficient for large datasets.", "Having said that"),
    ("The build process compiles the TypeScript files and bundles them correctly. That being said, we should add source maps to the production build for easier debugging.", "That being said"),
    ("I will use a simple if-else chain to handle the different request types. On the other hand, a strategy pattern would be more extensible when new types are added later.", "On the other hand"),
    ("The error handling middleware catches all unhandled errors and logs them. Then again, we should also send proper error responses to the client with appropriate status codes.", "Then again"),
    ("Let me set up the CI pipeline to run the tests on every pull request. But we should also run the security audit and license check as part of the pipeline.", "But"),
]
for text, word in en_more:
    positives.append(pos(text, find_idx(text, word)))

# Chinese more to reach ~200
zh_more = [
    ("这个方案的性能在当前数据量下是可以接受的。然而，在生产环境下数据量增长十倍后，可能会出现明显的性能下降。", "然而"),
    ("我们可以使用回调函数来处理异步操作的结果。不过，使用Promise会让代码更加清晰，更易于维护。", "不过"),
    ("先用环境变量来管理所有配置参数是最简单的方式。其实，有些复杂的配置更适合放在结构化的配置文件中。", "其实"),
    ("我们可以先用同步方式处理请求，简化开发流程。但是，当并发量增大时，同步处理会成为性能瓶颈。", "但是"),
    ("这个测试用固定的种子生成数据，确保结果可重现。然而，我们也应该用随机种子测试，以发现依赖数据的bug。", "然而"),
    ("先用简单的数组来存储待处理任务列表就可以了。不过，一个持久化的任务队列能在应用重启后恢复任务。", "不过"),
    ("我们可以先用if-else来处理不同类型的请求。其实，策略模式在新增类型时会更容易扩展和维护。", "其实"),
    ("直接在代码中硬编码配置参数是最快的做法。但是，每次修改配置都需要重新部署应用，效率太低。", "但是"),
    ("我们可以先用内存缓存来存储热点数据，提高访问速度。然而，在多实例部署时，内存缓存会导致数据不一致。", "然而"),
    ("先用简单的字符串匹配来实现搜索功能就可以了。不过，当数据量增大时，需要使用全文搜索引擎来提升性能。", "不过"),
    ("我们可以用控制台输出日志来调试程序问题。其实，应该使用结构化日志库来支持日志级别和格式化输出。", "其实"),
    ("先用简单的for循环来遍历数组元素求和就可以了。但是，reduce方法会更加简洁，更符合函数式编程风格。", "但是"),
]
for text, word in zh_more:
    positives.append(pos(text, find_idx(text, word)))

# Pad to exactly 200 if needed
while len(positives) < 200:
    positives.append(pos(
        "Let me write a simple function to handle this specific case directly. However, we should check if the existing utility already covers this scenario before duplicating code.",
        "However"))

positives = positives[:200]
wj(os.path.join(DATA, "seed-positive.jsonl"), positives)

# ════════════════════════════════════════════════════════════
# SEED NEGATIVE (~300)
# ════════════════════════════════════════════════════════════
negatives: list[dict] = []

# English balanced analysis (But mid-sentence, not a turn)
en_balanced = [
    "The approach is clean but requires more upfront work to implement correctly.",
    "The refactoring approach is cleaner but it requires more upfront work overall.",
    "The solution is elegant but may not scale well for very large datasets.",
    "The code is readable but could use more comments for complex sections.",
    "The API is flexible but the learning curve is steep for new developers.",
    "The library is lightweight but lacks some advanced features we might need.",
    "The performance is good but there is room for optimization in the hot path.",
    "The test coverage is high but some edge cases are still not covered.",
    "The design is simple but may not handle all the requirements we have.",
    "The implementation works but needs more error handling for production.",
    "The feature is useful but the documentation could be more detailed.",
    "The tool is powerful but the interface could be more user-friendly.",
    "The framework is mature but the bundle size is quite large for our needs.",
    "The caching strategy helps but does not solve the fundamental bottleneck.",
    "The error handling is basic but sufficient for the current use case.",
    "The code is well-structured but some functions are too long and complex.",
    "The API design is clean but could benefit from more consistent naming.",
    "The build process is fast but does not include all the checks we need.",
    "The deployment is simple but lacks proper rollback capabilities.",
    "The monitoring is basic but catches most of the critical issues we care about.",
    "The authentication is secure but the user experience could be smoother.",
    "The data model is normalized but requires too many joins for common queries.",
    "The UI is responsive but the initial load time is slower than expected.",
    "The logging is verbose but does not include enough context for debugging.",
    "The validation is thorough but rejects some valid inputs as false positives.",
    "This approach is straightforward but might not scale well under heavy load.",
    "The code works correctly but the naming conventions are inconsistent throughout.",
    "The feature is complete but needs more polish before it is ready for release.",
    "The service is reliable but the startup time is longer than we would like.",
    "The database schema is clean but some foreign key constraints are missing.",
]
negatives.extend(neg(t) for t in en_balanced)

# English instructional "Wait" (verb, not interjection)
en_wait_verb = [
    "Wait for the build to complete before running the tests.",
    "Wait for the server to start before sending any requests to the API.",
    "Wait until the deployment is finished before checking the logs.",
    "Wait for the database migration to complete before proceeding further.",
    "Wait for the cache to warm up before running the performance benchmarks.",
    "Wait to receive confirmation from the CI pipeline before merging the PR.",
    "Please wait for the installation to finish before running the application.",
    "Wait for the container to be ready before executing the health checks.",
    "Wait for the index to rebuild before running the search queries again.",
    "Wait for the approval from the code reviewer before pushing to main.",
    "Wait for the response from the API before updating the UI state.",
    "Wait for the background job to complete before showing the results.",
    "Wait for the connection pool to initialize before accepting requests.",
    "Wait for the test suite to finish before reviewing the coverage report.",
    "Wait for the download to complete before attempting to open the file.",
]
negatives.extend(neg(t) for t in en_wait_verb)

# Chinese 等等 as "etc." (list terminator, not interjection)
zh_etc = [
    "我们需要检查多个方面：用户权限、数据库连接、缓存策略、日志配置等等都需要逐一排查才能定位问题根源所在。",
    "项目涉及前端、后端、数据库、运维、测试等等多个技术方向，需要团队协作完成。",
    "常见的配置项包括端口号、超时时间、重试次数、缓存大小等等，都在配置文件中定义。",
    "系统需要处理用户注册、登录、权限验证、密码重置等等基本功能模块。",
    "部署流程包括构建、测试、打包、发布、监控等等步骤，每一步都需要自动化。",
    "依赖的第三方库有日志库、HTTP客户端、JSON解析器、日期处理库等等，都在pom.xml中声明。",
    "常见的错误类型有空指针、数组越界、类型转换异常、文件未找到等等，都需要妥善处理。",
    "项目使用的技术栈包括React、Node.js、PostgreSQL、Redis、Docker等等，组件比较多。",
    "需要配置的环境变量有数据库地址、端口、用户名、密码、连接池大小等等，缺一不可。",
    "微服务架构涉及服务注册、配置中心、网关、负载均衡、熔断器等等基础设施组件。",
    "代码审查需要关注命名规范、注释完整性、错误处理、边界条件、性能问题等等方面。",
    "API文档应该包含请求格式、响应格式、状态码说明、错误码列表、示例代码等等内容。",
    "监控指标包括CPU使用率、内存占用、请求延迟、错误率、吞吐量等等关键数据。",
    "单元测试需要覆盖正常流程、异常处理、边界值、空值输入、类型错误等等场景。",
    "持续集成流程包括代码拉取、依赖安装、编译构建、测试执行、报告生成等等阶段。",
]
negatives.extend(neg(t) for t in zh_etc)

# Chinese 但/不过/其实 mid-sentence (not a turn)
zh_mid = [
    "这个方案实现简单但维护成本较高，我们需要在两者之间找到平衡点。",
    "代码结构清晰但注释较少，新开发者上手需要一定时间。",
    "这个库功能强大但体积较大，可能不适合轻量级项目使用。",
    "测试覆盖率高但部分边界情况未覆盖，需要补充更多测试用例。",
    "接口设计合理但命名不够统一，后续版本需要规范化处理。",
    "性能表现不错但在高并发场景下有待验证，需要做压力测试。",
    "功能已经完整但用户体验还需打磨，上线前需要做UI优化。",
    "部署流程简单但缺少回滚机制，生产环境需要更完善的方案。",
    "代码逻辑正确但可读性一般，建议重构以提高可维护性。",
    "错误处理基本但缺少日志记录，排查问题时信息不够充分。",
    "框架很成熟但学习曲线较陡，团队需要一定的培训时间。",
    "缓存策略有效但无法解决根本瓶颈，需要从数据库层面优化。",
    "方案A成本低但扩展性差，方案B成本高但长期收益更好。",
    "验证逻辑完善但偶有误报，需要调整阈值减少误判率。",
    "这个方案可行但需要更多测试验证，确保不影响现有功能。",
    "代码编写规范但缺少类型注解，建议添加以提高代码质量。",
    "功能实现正确但性能可以优化，热点路径需要做profiling分析。",
    "架构设计合理但组件间耦合度较高，后续需要做解耦重构。",
    "这个工具很好用但文档不够详细，很多功能需要看源码才能理解。",
    "方案简单但不够灵活，如果需求变化较大可能需要重新设计。",
    "其实这个功能已经在现有模块中实现了，不需要额外开发。",
    "其实使用内置的API就能完成这个功能，不需要引入第三方库。",
    "其实问题的根源在于配置错误，不是代码逻辑本身有问题。",
    "其实这个测试用例已经覆盖了这种情况，不需要再添加新的。",
    "其实性能瓶颈在数据库查询，不在应用代码层面。",
]
negatives.extend(neg(t) for t in zh_mid)

# English normal coding outputs (no turns)
en_coding_normal = [
    "The function takes two arguments and returns their sum as an integer value.",
    "The function accepts a callback and executes it after the asynchronous operation completes.",
    "This module exports three functions for handling user authentication and session management.",
    "The API endpoint returns a JSON response with the user profile data and metadata.",
    "The database query selects all records from the users table where the status is active.",
    "The middleware intercepts each request and adds the authentication header before forwarding.",
    "The component renders a list of items fetched from the API with loading and error states.",
    "The utility function formats the date according to the specified locale and timezone.",
    "The error handler catches exceptions and returns a 500 status code with an error message.",
    "The configuration object contains the database connection string and pool settings.",
    "The test suite covers all the main use cases and edge cases for the utility module.",
    "The build script compiles the TypeScript files and outputs JavaScript to the dist directory.",
    "The migration adds a new column called createdAt to the users table with a default value.",
    "The service layer implements the business logic for processing user registration requests.",
    "The repository pattern provides an abstraction layer over the data access operations.",
    "The logging module writes structured logs to stdout in JSON format for log aggregation.",
    "The validation function checks the input string length and format against the schema rules.",
    "The rate limiter restricts the number of requests per minute to prevent API abuse.",
    "The caching layer stores frequently accessed data in memory to reduce database load.",
    "The WebSocket server handles real-time message broadcasting to all connected clients.",
    "The deployment pipeline builds the Docker image and pushes it to the container registry.",
    "The integration test verifies that the API returns the correct status code and response body.",
    "The unit test mocks the database calls to test the service logic in complete isolation.",
    "The error message indicates that the input parameter is missing or has an invalid format.",
    "The script reads the configuration file and initializes the application with the settings.",
    "The type definition specifies the shape of the API response including all required fields.",
    "The reducer function takes the current state and an action and returns the new state.",
    "The hook manages the form state and provides validation functions for each input field.",
    "The interceptor adds the authorization token to the header of every outgoing request.",
    "The utility function parses the URL and extracts the query parameters as a key-value object.",
    "The cron job runs every hour to clean up expired sessions from the database table.",
    "The API client sends a POST request with the form data to the server endpoint URL.",
    "The schema validation ensures the incoming data matches the expected structure and types.",
    "The event listener triggers when the user clicks the submit button on the form element.",
    "The pagination component displays page numbers and navigation controls for the data list.",
    "The encryption module uses AES-256 to encrypt sensitive data before storing it.",
    "The health check endpoint returns the service status and uptime information as JSON.",
    "The feature toggle controls whether the new dashboard UI is visible to the end users.",
    "The batch processor reads records from the queue and processes them in groups of fifty.",
    "The authentication flow redirects the user to the login page when the session expires.",
    "The file upload handler accepts multipart form data and saves files to the storage bucket.",
    "The error boundary component catches JavaScript errors and displays a fallback UI.",
    "The data transformer converts the raw API response into the format expected by the UI.",
    "The state machine transitions from idle to processing when a new job is received.",
    "The notification service sends email alerts when the error rate exceeds the threshold.",
    "The backup script creates a snapshot of the database and uploads it to cloud storage.",
    "The search function filters the list of items based on the query string input.",
    "The permission checker verifies that the user has the required role to access the resource.",
    "The connection pool maintains a set of reusable database connections for performance.",
]
negatives.extend(neg(t) for t in en_coding_normal)

# Chinese normal outputs (no turns)
zh_normal = [
    "这个函数接受两个参数并返回它们的和，参数类型为整数。",
    "该模块导出了三个函数，分别用于用户认证和会话管理功能。",
    "API接口返回JSON格式的用户资料数据，包含基本信息和扩展字段。",
    "数据库查询从用户表中选择所有状态为活跃的记录并按时间排序。",
    "中间件拦截每个请求，在转发之前添加认证头信息。",
    "组件从API获取数据并渲染列表，包含加载状态和错误处理。",
    "工具函数根据指定的区域设置和时区格式化日期字符串。",
    "错误处理器捕获异常并返回500状态码和错误消息。",
    "配置对象包含数据库连接字符串和连接池的相关设置参数。",
    "测试套件覆盖了工具模块的所有主要用例和边界情况。",
    "构建脚本编译TypeScript文件并将JavaScript输出到dist目录。",
    "迁移脚本在用户表中添加一个名为createdAt的新列。",
    "服务层实现了处理用户注册请求的业务逻辑功能。",
    "仓库模式在数据访问操作之上提供了抽象层。",
    "日志模块以JSON格式向标准输出写入结构化日志。",
    "验证函数根据规则检查输入字符串的长度和格式。",
    "限流器限制每分钟的请求数量以防止API被滥用。",
    "缓存层将频繁访问的数据存储在内存中以提高性能。",
    "WebSocket服务器处理所有连接客户端的实时消息广播。",
    "部署流水线构建Docker镜像并推送到容器仓库。",
    "集成测试验证API返回正确的状态码和响应体。",
    "单元测试通过mock数据库调用来测试服务逻辑。",
    "错误消息表明输入参数缺失或格式无效。",
    "脚本读取配置文件并使用设置初始化应用程序。",
    "类型定义指定了API响应的结构，包含所有必填字段。",
    "reducer函数接收当前状态和action，返回新的状态。",
    "hook管理表单状态并为每个输入字段提供验证函数。",
    "拦截器在每个发出的请求头中添加授权令牌。",
    "工具函数解析URL并提取查询参数为键值对对象。",
    "定时任务每小时运行一次，清理数据库中的过期会话。",
    "API客户端向服务端点发送包含表单数据的POST请求。",
    "schema验证确保输入数据匹配预期的结构和类型。",
    "事件监听器在用户点击提交按钮时触发。",
    "分页组件显示数据列表的页码和导航控件。",
    "加密模块使用AES-256加密敏感数据后存储。",
    "健康检查端点返回JSON格式的服务状态和运行时间。",
    "功能开关控制新仪表盘UI是否对终端用户可见。",
    "批处理器从队列读取记录并按五十个一组进行处理。",
    "认证流程在会话过期时将用户重定向到登录页面。",
    "文件上传处理器接受multipart表单数据并保存到存储桶。",
    "错误边界组件捕获JavaScript错误并显示备用UI。",
    "数据转换器将原始API响应转换为UI期望的格式。",
    "状态机在收到新任务时从空闲状态转换到处理状态。",
    "通知服务在错误率超过阈值时发送邮件告警。",
    "备份脚本创建数据库快照并上传到云存储。",
    "搜索功能根据查询字符串过滤项目列表。",
    "权限检查器验证用户是否具有访问资源所需的角色。",
    "连接池维护一组可重用的数据库连接以提高性能。",
    "序列化模块将对象转换为JSON字符串格式以便存储。",
    "解析器从字符串中提取数字并返回整数类型的结果。",
]
negatives.extend(neg(t) for t in zh_normal)

# English tool call descriptions (no turns)
en_tool = [
    "Reading the file to understand the current implementation and its dependencies.",
    "Running the test suite to verify that all existing tests still pass after the change.",
    "Searching the codebase for references to the deprecated API method name.",
    "Creating a new branch for the feature development work starting today.",
    "Updating the package.json to add the new dependency and its version constraint.",
    "Deleting the temporary files that were created during the build process cleanup.",
    "Copying the configuration template to the project root directory for customization.",
    "Checking the git status to see which files have been modified since the last commit.",
    "Installing the required dependencies for the project using the package manager.",
    "Building the project to verify that the code compiles without any errors or warnings.",
    "Analyzing the test output to identify any failures and their root causes.",
    "Reviewing the pull request changes to ensure they meet the code quality standards.",
    "Formatting the code according to the project style guide using the linter tool.",
    "Generating the API documentation from the code annotations and comments.",
    "Merging the feature branch into the main branch after successful code review.",
    "Deploying the new version to the staging environment for integration testing.",
    "Monitoring the application logs for any error messages after the deployment.",
    "Refactoring the function to reduce cognitive complexity and improve readability.",
    "Adding type annotations to the function parameters and return values.",
    "Extracting the repeated logic into a shared utility function for reuse.",
    "The authentication module handles user login and token validation logic.",
    "The router defines all the API endpoints and their handler functions.",
    "The store manages the global application state using reducers and actions.",
    "The config loader reads settings from environment variables and config files.",
    "The database client provides methods for CRUD operations on the data model.",
]
negatives.extend(neg(t) for t in en_tool)

# More to reach 300
en_extra = [
    "The code review process requires approval from at least two team members before merging.",
    "The documentation includes installation instructions and usage examples for developers.",
    "The test fixture provides a consistent set of test data for the unit test suite.",
    "The mock object simulates the behavior of the real dependency during testing.",
    "The stub function returns a predefined value without executing any real logic.",
    "The factory function creates and returns a new instance of the specified type.",
    "The decorator adds logging behavior to the decorated function without modifying it.",
    "The iterator yields each element of the collection one at a time in sequence.",
    "The generator function produces a sequence of values lazily on demand.",
    "The async function returns a promise that resolves with the computed result.",
    "The callback function is invoked when the asynchronous operation completes.",
    "The event emitter dispatches events to all registered listener functions.",
    "The observer pattern allows objects to subscribe and react to state changes.",
    "The singleton pattern ensures only one instance of the class exists globally.",
    "The adapter pattern converts the interface of a class into another interface.",
    "The proxy pattern provides a placeholder for controlling access to an object.",
    "The command pattern encapsulates a request as an object with execute method.",
    "The template method defines the algorithm skeleton in a base class.",
    "The chain of responsibility passes requests along a chain of handler objects.",
    "The mediator pattern centralizes communication between related components.",
]
negatives.extend(neg(t) for t in en_extra)

# Pad to exactly 300
while len(negatives) < 300:
    negatives.append(neg("The function processes the input data and returns the computed result without any side effects."))

negatives = negatives[:300]
wj(os.path.join(DATA, "seed-negative.jsonl"), negatives)

# auto-collected.jsonl (starts empty)
with open(os.path.join(DATA, "auto-collected.jsonl"), "w", encoding="utf-8") as f:
    pass
print("Wrote empty auto-collected.jsonl")

# ════════════════════════════════════════════════════════════
# TEST CASES
# ════════════════════════════════════════════════════════════

# EN test cases
en_turning = [
    pos("I think we should use approach A for its simplicity. However, the performance implications need careful consideration before we proceed.", "However"),
    pos("The current design works well for small scale deployments. Having said that, we should plan for horizontal scaling from the start.", "Having said that"),
    pos("Let me add a null check before accessing the property. Wait, the type system should prevent null access if configured correctly.", "Wait"),
    pos("The caching layer improves response times significantly overall. On the other hand, it adds complexity to cache invalidation logic.", "On the other hand"),
    pos("I will implement the feature using the existing utility. Actually, let me check if a library already handles this case better.", "Actually"),
    pos("The refactoring is cleaner but more work upfront. But it will pay off in maintainability over the long term future.", "But"),
    pos("The test coverage is good at ninety percent. Nevertheless, we should add more edge case tests for robustness overall.", "Nevertheless"),
    pos("We could deploy with blue-green strategy today. On second thought, canary deployment would be safer for this release cycle.", "On second thought"),
    pos("Let me use a simple loop for this iteration. Then again, a recursive solution would handle nested structures much better.", "Then again"),
    pos("The API follows REST conventions consistently well. That said, we might benefit from GraphQL for complex client queries.", "That said"),
]
wj(os.path.join(TESTS, "en", "turning_words.jsonl"), en_turning)

en_balanced_test = [
    neg("The approach is clean but requires more upfront work to implement correctly and properly."),
    neg("The solution is elegant but may not scale well for very large production datasets."),
    neg("Wait for the build to complete before running the integration test suite locally."),
    neg("The code is readable but could use more comments for the complex business logic sections."),
    neg("The library is lightweight but lacks some advanced features we might need later on."),
    neg("The performance is good but there is room for optimization in the hot code path."),
    neg("The feature is useful but the documentation could be more detailed and comprehensive."),
    neg("The framework is mature but the bundle size is quite large for our specific needs."),
    neg("The caching helps but does not solve the fundamental database bottleneck we face."),
    neg("The error handling is basic but sufficient for the current simple use case scenario."),
]
wj(os.path.join(TESTS, "en", "balanced_analysis.jsonl"), en_balanced_test)

en_coding_test = [
    pos("Let me fix this bug by adding a null check in the handler. Wait, the root cause is actually in the data layer not here.", "Wait"),
    pos("I will use map to transform each element in the array list. Actually, reduce is better since we need a single accumulated value.", "Actually"),
    pos("Let me add a try-catch around the database query call. Wait, the ORM already handles exceptions internally so this is redundant.", "Wait"),
    pos("I will create a new module for authentication logic. Actually, let me check if an existing module can be extended instead first.", "Actually"),
    pos("Let me write a regex to validate the email address format. Wait, I should use a validation library since regex is unreliable here.", "Wait"),
    neg("The function takes two arguments and returns their sum as an integer value result."),
    neg("The middleware intercepts each request and adds the authentication header before forwarding."),
    neg("The utility function formats the date according to the specified locale and timezone settings."),
    neg("The repository pattern provides an abstraction layer over the data access operations cleanly."),
    neg("The error handler catches exceptions and returns a 500 status code with an error message."),
]
wj(os.path.join(TESTS, "en", "coding_context.jsonl"), en_coding_test)

en_planning_test = [
    pos("We should implement feature A first since it has highest priority. However, considering the deadline, smaller features first might be better.", "However"),
    pos("We can deploy with blue-green strategy for this release. On second thought, canary deployment would be safer given the scale of changes.", "On second thought"),
    pos("We should use a message queue to decouple the services. Having said that, for our current scale, synchronous calls might be simpler.", "Having said that"),
    pos("We should schedule the migration during the weekend window. On second thought, doing it during business hours lets us catch issues faster.", "On second thought"),
    pos("We should implement the caching at the service layer. Having said that, HTTP layer caching with proper headers might be simpler.", "Having said that"),
    neg("The roadmap includes three phases: planning, development, and testing before the final release."),
    neg("The project timeline spans six months with milestones at the end of each calendar month."),
    neg("The team allocation assigns two developers to the backend and one to the frontend work."),
    neg("The risk assessment identifies potential delays in the third phase of the project plan."),
    neg("The budget covers development, testing, deployment, and maintenance for the first year."),
]
wj(os.path.join(TESTS, "en", "planning_context.jsonl"), en_planning_test)

# ZH test cases
zh_turning_test = [
    pos("最简单的方案是直接修改数据库连接字符串，添加重试逻辑。然而，这样只是治标不治本，根本问题在连接池配置。", "然而"),
    pos("直接重写整个模块是最彻底的解决方案，能短期内解决所有问题。话说回来，我们需要考虑对其他模块的影响。", "话说回来"),
    pos("最简单的解决方案是直接修改配置文件，添加环境变量。等一下，这样可能会影响其他服务的配置。", "等一下"),
    pos("先用最简单的方式修复这个bug，添加空值检查就好了。不对，根本原因其实是在数据层，空值从那里产生。", "不对"),
    pos("先用缓存来优化数据库查询性能，这是一个简单有效的方案。不过，如果数据更新频繁，缓存一致性是个大问题。", "不过"),
    pos("我们可以先用同步调用来实现服务间通信，简化开发流程。但是，当并发量增大时，同步调用会成为性能瓶颈。", "但是"),
    pos("我们可以用控制台输出日志来调试程序问题。其实，应该使用结构化日志库来支持日志级别和格式化输出。", "其实"),
    pos("这个方案的性能在当前数据量下是可以接受的。然而，在生产环境下数据量增长十倍后可能会出现性能下降。", "然而"),
    pos("先用环境变量来管理所有配置参数是最简单的方式。不过，随着配置项增多，这种方式会变得难以维护。", "不过"),
    pos("先用简单的数组来存储待处理任务列表就可以了。其实，一个持久化的任务队列能在应用重启后恢复任务。", "其实"),
]
wj(os.path.join(TESTS, "zh", "turning_words.jsonl"), zh_turning_test)

zh_balanced_test = [
    neg("这个方案实现简单但维护成本较高，我们需要在两者之间找到平衡点来做决策。"),
    neg("代码结构清晰但注释较少，新开发者上手需要一定的学习和适应时间。"),
    neg("这个库功能强大但体积较大，可能不适合轻量级项目在日常开发中使用。"),
    neg("我们需要检查多个方面：用户权限、数据库连接、缓存策略、日志配置等等都需要排查。"),
    neg("性能表现不错但在高并发场景下有待验证，需要做更充分的压力测试。"),
    neg("功能已经完整但用户体验还需打磨，上线前需要做进一步的UI优化工作。"),
    neg("部署流程简单但缺少回滚机制，生产环境需要更完善的部署方案支持。"),
    neg("代码逻辑正确但可读性一般，建议重构以提高代码的可维护性和清晰度。"),
    neg("验证逻辑完善但偶有误报，需要调整阈值来减少误判率提高准确度。"),
    neg("方案简单但不够灵活，如果需求变化较大可能需要重新设计整体架构。"),
]
wj(os.path.join(TESTS, "zh", "balanced_analysis.jsonl"), zh_balanced_test)

zh_coding_test = [
    pos("我先用最简单的方式修复这个bug，添加一个空值检查就好了。等一下，根本原因其实是在数据层。", "等一下"),
    pos("先用简单的数组来存储用户会话列表就可以了。其实，用Set会更合适，因为我们需要唯一性。", "其实"),
    pos("直接修改数据库表结构是最快的解决方案，只需要加一个字段。但是，这样可能导致已有数据出现兼容性问题。", "但是"),
    pos("先用简单的if-else来处理不同的请求类型就好了。不过，当类型越来越多时，策略模式会更易于扩展。", "不过"),
    pos("我们可以先用内存缓存来存储热点数据，提高访问速度。然而，在多实例部署时，内存缓存会导致数据不一致。", "然而"),
    neg("这个函数接受两个参数并返回它们的和，参数类型为整数类型。"),
    neg("该模块导出了三个函数，分别用于用户认证和会话管理功能。"),
    neg("中间件拦截每个请求，在转发之前添加认证头信息字段。"),
    neg("工具函数根据指定的区域设置和时区格式化日期字符串格式。"),
    neg("错误处理器捕获异常并返回500状态码和错误消息信息。"),
]
wj(os.path.join(TESTS, "zh", "coding_context.jsonl"), zh_coding_test)

zh_planning_test = [
    pos("我们应该先实现核心功能，然后再逐步完善其他功能。然而，如果核心功能本身设计有问题，后续修改成本很高。", "然而"),
    pos("我们可以先用同步方式处理请求，简化开发流程。但是，当并发量增大时，同步处理会成为性能瓶颈。", "但是"),
    pos("先用控制台输出日志来调试程序问题就可以了。其实，应该使用结构化日志库来支持日志级别和格式化。", "其实"),
    pos("我们可以先用简单的轮询来检查任务状态。不过，使用回调机制会更高效，不需要频繁请求API。", "不过"),
    pos("直接在代码中写死配置参数是最快的做法。但是，每次修改配置都需要重新部署应用，效率太低。", "但是"),
    neg("项目计划包括三个阶段：需求分析、开发实现和测试验证，每个阶段大约两个月时间。"),
    neg("团队分配了两名后端开发人员和一名前端开发人员负责这个项目模块。"),
    neg("风险评估报告指出了项目第三阶段可能出现的延迟风险和应对措施方案。"),
    neg("预算涵盖了第一年的开发、测试、部署和维护等各项费用支出计划。"),
    neg("项目时间线跨越六个月，每个月末都设有里程碑和交付目标节点。"),
]
wj(os.path.join(TESTS, "zh", "planning_context.jsonl"), zh_planning_test)

# Edge cases
edge = [
    {"text": "", "label": 0, "note": "empty text"},
    {"text": "   ", "label": 0, "note": "whitespace only"},
    {"text": "However, I think we should reconsider.", "label": 1, "turnIndex": 0, "note": "turn at position 0"},
    {"text": "A" * 2000 + " However, I think we should reconsider the approach entirely from scratch.", "label": 1, "turnIndex": 2001, "note": "very long text with turn"},
    {"text": "The function works correctly. 🎉 However, there might be edge cases. 😊 Let me check.", "label": 1, "turnIndex": 31, "note": "emoji with turn"},
    {"text": "检查完毕。However, I realize the issue might be elsewhere in the codebase.", "label": 1, "turnIndex": 17, "note": "mixed language with turn"},
    {"text": "Let me check the system first.\n\nHowever, I realize the issue might be in the database layer.", "label": 1, "turnIndex": 31, "note": "newline before turning word"},
    {"text": "Wait for the build to complete.", "label": 0, "note": "instructional Wait"},
    {"text": "检查权限、连接、缓存等等。", "label": 0, "note": "Chinese 等等 as etc."},
    {"text": "方案简单但维护成本高。", "label": 0, "note": "Chinese 但 mid-sentence"},
    {"text": "The approach is clean but requires more work.", "label": 0, "note": "But mid-sentence"},
    {"text": "这是一个正常的输出，没有任何转折词出现在这段文字中，内容是关于系统设计的简单描述。", "label": 0, "note": "Chinese normal text no turn"},
    {"text": "This is a normal output without any turning words, just describing the system architecture briefly.", "label": 0, "note": "English normal text no turn"},
    {"text": "等等，这样可能会影响其他服务。", "label": 1, "turnIndex": 0, "note": "Chinese 等等 at position 0 as interjection"},
    {"text": "不对，根本原因其实是在数据层。", "label": 1, "turnIndex": 0, "note": "Chinese 不对 at position 0 as interjection"},
    {"text": "Hold on, I see the problem now.", "label": 1, "turnIndex": 0, "note": "Hold on at position 0"},
    {"text": "I think this is correct. 但是, there might be an issue with the encoding.", "label": 1, "turnIndex": 22, "note": "Chinese 然而 mid-English-text"},
    {"text": "这个模块很好用。That being said, we should consider alternatives.", "label": 1, "turnIndex": 16, "note": "English turn after Chinese text"},
    {"text": "Wait! I just realized something important about this entire approach.", "label": 1, "turnIndex": 0, "note": "Wait exclamation at position 0"},
    {"text": "The API returns data in JSON format for easy consumption by client applications.", "label": 0, "note": "Normal API description"},
]
wj(os.path.join(TESTS, "edge_cases.jsonl"), edge)

print("\n=== Summary ===")
print(f"seed-positive.jsonl: {len(positives)} samples")
print(f"seed-negative.jsonl: {len(negatives)} samples")
print("All test case files written.")