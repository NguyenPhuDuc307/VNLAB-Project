// MCP server (Streamable HTTP, không giữ phiên) ở /mcp — như VNLab Stock. Mỗi
// request dựng một McpServer mới gắn với người dùng của token: rẻ và không có
// trạng thái nào phải dọn. Token là "vpj_…" người dùng tạo trong Cài đặt.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { UserRow } from './data.ts';
import { today } from './dates.ts';
import { runTool, ToolError, TOOLS } from './tools.ts';

const instructions = (user: UserRow) => `VNLab Project — kế hoạch dự án của ${user.name || user.email} (project.vnlab.id.vn): dự án → nhóm việc → việc (phụ trách, hỗ trợ, tiến độ %, ngày bắt đầu/kết thúc, ngày công) trên biểu đồ Gantt theo ngày.
Hôm nay là ${today()} (giờ Việt Nam). Ngày ghi dạng YYYY-MM-DD; tiến độ 0–100.
Bắt đầu bằng list_projects (hoặc get_overview) để lấy projectId; get_project để thấy nhóm và việc kèm id trước khi sửa/xoá.
Khi người dùng đọc cả kế hoạch (nhiều dòng) thì dùng create_tasks một lần, ghi tên nhóm vào từng việc. Không tự bịa ngày, người phụ trách hay tiến độ: thiếu thì để trống và hỏi lại.
Xoá việc chỉ khi người dùng nói rõ. Bạn chỉ thấy dự án mình là chủ hoặc được mời; dự án "chỉ xem" không ghi được.`;

export function buildMcp(user: UserRow) {
  const server = new McpServer({ name: 'vnlab-project', version: '1.0.0' }, { instructions: instructions(user) });
  for (const [name, t] of Object.entries(TOOLS)) {
    server.registerTool(
      name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input.shape,
        annotations: { readOnlyHint: !t.write, destructiveHint: t.destructive ?? !!t.write, openWorldHint: false },
      },
      async (args: unknown) => {
        try {
          const out = await runTool(user, name, args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
        } catch (err) {
          const msg = err instanceof ToolError ? err.message : `Lỗi: ${(err as Error).message}`;
          if (!(err instanceof ToolError)) console.error(`[mcp] ${name}`, err);
          return { content: [{ type: 'text' as const, text: msg }], isError: true };
        }
      },
    );
  }
  return server;
}

export async function handleMcp(req: Request, user: UserRow) {
  const server = buildMcp(user);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void transport.close();
    void server.close();
  }
}
