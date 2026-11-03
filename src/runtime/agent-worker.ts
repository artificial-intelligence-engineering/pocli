import readline from 'node:readline';
import {
  AgentTurnInput,
  LlmGateway,
} from './llm-gateway.js';
import {
  JsonRpcNotification,
  JsonRpcRequestSchema,
  JsonRpcResponse,
} from '../core/contracts.js';

const gateway = new LlmGateway();

function sendJsonRpc(message: JsonRpcResponse | JsonRpcNotification): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(trimmed);
  } catch (err) {
    sendJsonRpc({
      jsonrpc: '2.0',
      id: 'invalid',
      error: { code: -32700, message: `Parse error: ${(err as Error).message}` },
    });
    return;
  }

  const parsed = JsonRpcRequestSchema.safeParse(parsedUnknown);
  if (!parsed.success) {
    sendJsonRpc({
      jsonrpc: '2.0',
      id: 'invalid',
      error: { code: -32600, message: 'Invalid JSON-RPC 2.0 Request' },
    });
    return;
  }

  const req = parsed.data;

  try {
    if (req.method === 'agent.ping') {
      sendJsonRpc({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          status: 'ok',
          pid: process.pid,
          platform: process.platform,
        },
      });
      return;
    }

    if (req.method === 'agent.executeTurn') {
      const turnInput = req.params as unknown as AgentTurnInput;
      const output = await gateway.generateAgentTurn(turnInput, (chunk) => {
        sendJsonRpc({
          jsonrpc: '2.0',
          method: 'agent.streamChunk',
          params: {
            role: turnInput.role,
            chunk,
          },
        });
      });

      sendJsonRpc({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          ...output,
          workerPid: process.pid,
        },
      });
      return;
    }

    if (req.method === 'agent.health') {
      sendJsonRpc({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          status: 'healthy',
          pid: process.pid,
          uptime: process.uptime(),
          platform: process.platform,
        },
      });
      return;
    }

    if (req.method === 'agent.interAgentMessage') {
      sendJsonRpc({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          received: true,
          workerPid: process.pid,
          messageId: (req.params as Record<string, unknown> | undefined)?.id,
        },
      });
      return;
    }

    if (req.method === 'agent.shutdown') {
      sendJsonRpc({
        jsonrpc: '2.0',
        id: req.id,
        result: { shutdown: true },
      });
      process.exit(0);
    }

    sendJsonRpc({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    });
  } catch (err) {
    sendJsonRpc({
      jsonrpc: '2.0',
      id: req.id,
      error: {
        code: -32000,
        message: (err as Error).message,
      },
    });
  }
});

