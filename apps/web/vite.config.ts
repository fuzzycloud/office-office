import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		proxy: {
			"/rpc": { target: "http://localhost:8080", changeOrigin: true },
			"/api/files": { target: "http://localhost:8080", changeOrigin: true },
		},
	},
});
