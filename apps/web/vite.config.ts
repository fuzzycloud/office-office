import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		tanstackRouter({
			target: "react",
			autoCodeSplitting: true,
			quoteStyle: "double",
		}),
		react(),
		tailwindcss(),
	],
	server: {
		proxy: {
			"/auth": { target: "http://localhost:8080", changeOrigin: false },
			"/rpc": { target: "http://localhost:8080", changeOrigin: false },
			"/api/files": { target: "http://localhost:8080", changeOrigin: false },
		},
	},
});
