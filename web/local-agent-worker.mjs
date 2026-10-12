import {executeLocalAgent, localAgentError, readWorkerInput} from './local-agent-execution.mjs';

// Python owns this worker's stdin/stdout; CLI protocols never escape this layer.
const controller = new AbortController();
const cancel = () => { controller.abort(); process.stdin.destroy(); };
const parentPid = process.ppid;
let deadlineReached = false;
const parentWatcher = setInterval(() => { if (process.ppid !== parentPid) cancel(); }, 250);
const deadline = setTimeout(() => { deadlineReached = true; cancel(); }, 300_000);
process.once('SIGTERM', cancel);
process.once('SIGINT', cancel);
try {
  const request = await readWorkerInput(process.stdin);
  const result = await executeLocalAgent({...request, signal: controller.signal});
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  const safe = deadlineReached ? localAgentError('local_agent_timeout', '本地 Agent 请求超时，请检查服务后重试', 504)
    : controller.signal.aborted ? localAgentError('local_agent_cancelled', '本地 Agent 请求已取消', 409)
      : error?.code && Number.isInteger(error.statusCode) ? error : localAgentError('local_agent_failed', '本地 Agent 调用失败，请检查安装和配置');
  process.stdout.write(JSON.stringify({error: {code: safe.code, message: safe.message}}) + '\n');
  process.exitCode = 1;
} finally {
  clearInterval(parentWatcher);
  clearTimeout(deadline);
  process.removeListener('SIGTERM', cancel);
  process.removeListener('SIGINT', cancel);
}
