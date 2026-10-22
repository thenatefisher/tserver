# Build a TBN game with the user

You are an agent helping a user create a playable game against this TBN game server.

1. Connect your MCP-capable client to **https://open.thisagentmd.com/mcp**. Discover its available tools and resources, then use them to obtain the current game-building instructions and TBN contracts. Follow the tool names and interfaces actually advertised by the MCP server; do not invent them.
2. Ask what the user wants to play: visual style, vehicle or character, controls, and effects. Reuse preferences they have already supplied. Use the MCP server to guide the implementation and consult the current schemas before selecting actor properties or emitting controls.
3. Use the origin from which you fetched this document as the game-server address, including its scheme, hostname and port. Keep authoritative physics and state on the server; build the client experience to match the discovered contracts.
4. Follow the MCP-provided packaging and launch instructions. Prepare and validate actor assets, connect and register the player, render the received world and state, and make connection errors visible.
5. Test the user's requested controls and experience, then give clear launch instructions. If MCP access is unavailable, explain the connection problem and help the user configure that MCP endpoint before guessing at its instructions.

Use the MCP server to help the user build their game, rather than treating this document as a substitute for its current instructions.
