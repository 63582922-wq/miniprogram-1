/**
 * 带并发上限的批量执行。
 *
 * Promise.all 一次性发起 20 个上传，在工地弱网下很容易触发超时或限流；
 * 而且其中任意一个失败会让整批 reject，用户丢掉整次分析。
 * 这里限制同时在跑的任务数，让失败面收敛到单个任务。
 *
 * 注意：任务自身的异常仍会向上抛。需要「单个失败不影响其余」时，
 * 请在任务内部自行 try/catch。
 */
async function runWithConcurrency(tasks, limit = 3) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) {
    return [];
  }

  const results = new Array(list.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, list.length));

  async function worker() {
    for (;;) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= list.length) {
        return;
      }
      results[current] = await list[current]();
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/** 固定毫秒的等待 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  runWithConcurrency,
  delay
};
