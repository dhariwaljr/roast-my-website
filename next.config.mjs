/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next 16 otherwise drops AGENTS.md / CLAUDE.md into the project root on dev.
  agentRules: false,
};

export default nextConfig;
