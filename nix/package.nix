{
  lib,
  stdenvNoCC,
  makeWrapper,
  nodejs_22,
  python3,
  bun,
}:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "context-mode";
  version = "1.0.89";

  src = lib.cleanSource ../.;

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    install -d "$out/lib/${finalAttrs.pname}" "$out/bin"

    cp package.json "$out/lib/${finalAttrs.pname}/package.json"
    cp README.md "$out/lib/${finalAttrs.pname}/README.md"
    cp LICENSE "$out/lib/${finalAttrs.pname}/LICENSE"
    cp start.mjs "$out/lib/${finalAttrs.pname}/start.mjs"
    cp server.bundle.mjs "$out/lib/${finalAttrs.pname}/server.bundle.mjs"
    cp cli.bundle.mjs "$out/lib/${finalAttrs.pname}/cli.bundle.mjs"

    cp -r hooks "$out/lib/${finalAttrs.pname}/hooks"
    cp -r configs "$out/lib/${finalAttrs.pname}/configs"
    cp -r insight "$out/lib/${finalAttrs.pname}/insight"

    if [ -d skills ]; then
      cp -r skills "$out/lib/${finalAttrs.pname}/skills"
    fi

    if [ -d .claude-plugin ]; then
      cp -r .claude-plugin "$out/lib/${finalAttrs.pname}/.claude-plugin"
    fi

    if [ -d .openclaw-plugin ]; then
      cp -r .openclaw-plugin "$out/lib/${finalAttrs.pname}/.openclaw-plugin"
    fi

    if [ -d .pi ]; then
      cp -r .pi "$out/lib/${finalAttrs.pname}/.pi"
    fi

    if [ -f .mcp.json ]; then
      cp .mcp.json "$out/lib/${finalAttrs.pname}/.mcp.json"
    fi

    if [ -f openclaw.plugin.json ]; then
      cp openclaw.plugin.json "$out/lib/${finalAttrs.pname}/openclaw.plugin.json"
    fi

    chmod +x "$out/lib/${finalAttrs.pname}/cli.bundle.mjs"
    chmod +x "$out/lib/${finalAttrs.pname}/server.bundle.mjs"

    makeWrapper ${lib.getExe nodejs_22} "$out/bin/context-mode" \
      --add-flags "$out/lib/${finalAttrs.pname}/cli.bundle.mjs" \
      --prefix PATH : ${
        lib.makeBinPath [
          python3
          bun
        ]
      }

    runHook postInstall
  '';

  meta = {
    description = "MCP plugin and CLI for reducing context-window usage";
    homepage = "https://github.com/mksglu/context-mode";
    license = lib.licenses.elastic20;
    mainProgram = "context-mode";
    platforms = lib.platforms.all;
  };
})
