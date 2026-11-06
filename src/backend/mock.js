// 假后端：不调用 LLM，用于无网络/无凭据时把整条链路跑通。
import { createLogger } from '../log.js';

const log = createLogger('mock');

export function createMockBackend() {
  return {
    kind: 'mock',
    async run({ prompt, userText, nickname, personaName }) {
      log.debug('prompt 长度', prompt.length);
      await new Promise((r) => setTimeout(r, 30));
      const head = userText.slice(0, 40);
      return {
        text: `（${personaName}·离线自检）我听到 ${nickname} 说的「${head}」了。我现在跑在 mock 后端上，接上真模型后就会正经回答。`,
        sessionId: null,
        error: null,
      };
    },
    async close() {},
  };
}
