# WhatsApp MCP Server

This is a Model Context Protocol (MCP) server for WhatsApp. It lets you search and read your personal WhatsApp messages, search contacts, and send messages (including media files) to individuals or groups. All messages are stored locally in a SQLite database and only sent to an LLM (such as Claude) when accessed through tools you control.

## Backend Options

You can choose between two backend implementations:

- **Go backend** (`whatsapp-bridge-go/`): Implementation based on the [whatsmeow](https://github.com/tulir/whatsmeow) project by Tulir Asokan.
- **Node.js backend** (`whatsapp-bridge-node/`): Alternative backend using Node.js.

### Node.js Backend

1. Install dependencies:

   ```bash
   cd whatsapp-bridge-node
   npm install
   ```

2. Build the project:

   ```bash
   npm run build
   ```

3. Run the backend:

   ```bash
   node dist/index.js
   ```

### Go Backend

1. Navigate to the Go backend directory:

   ```bash
   cd whatsapp-bridge-go
   ```

2. Run the application:

   ```bash
   go run main.go
   ```

   The first time, scan the QR code with your WhatsApp app to authenticate.

## Installation

### Prerequisites

- Go (for Go backend)
- Node.js and npm (for Node.js backend)
- Python 3.6+
- Anthropic Claude Desktop app (or Cursor)
- UV (Python package manager)
- FFmpeg (optional, for audio message conversion)

### Steps

1. **Clone this repository**

   ```bash
   git clone https://github.com/mateusdata/whatsapp-mcp.git
   cd whatsapp-mcp
   ```

2. **Start your chosen backend** (see above).

3. **Connect to the MCP server**

   Configure your Claude Desktop or Cursor to use the MCP server by editing the config file as shown below:

   ```json
   {
     "mcpServers": {
       "whatsapp": {
         "command": "{{PATH_TO_UV}}",
         "args": [
           "--directory",
           "{{PATH_TO_SRC}}/whatsapp-mcp/whatsapp-mcp-server",
           "run",
           "main.py"
         ]
       }
     }
   }
   ```

   - For Claude Desktop: save as `claude_desktop_config.json` in `~/Library/Application Support/Claude/`
   - For Cursor: save as `mcp.json` in `~/.cursor/`

4. **Restart Claude Desktop or Cursor**

## Usage

Once connected, you can interact with your WhatsApp contacts through Claude, using tools such as:

- `search_contacts`
- `list_messages`
- `list_chats`
- `get_chat`
- `send_message`
- `send_file`
- `send_audio_message`
- `download_media`

## Troubleshooting

- Ensure both the backend and Python MCP server are running.
- For Go backend on Windows, enable CGO and install a C compiler.
- If authentication fails, restart the backend and re-scan the QR code.
- For media, use `download_media` to fetch files.

## Author

[Mateus Data](https://github.com/mateusdata)
