// git-env.mjs — the environment for a git this node spawns. An msys2 git (first on PATH under Git Bash)
// globs its argv when its parent is not msys: @{u} would arrive as @u, HEAD^{commit} as HEAD^commit.
export const gitEnv = (env = process.env) => ({ ...env, MSYS: `${env.MSYS ?? ''} noglob`.trim() });
