{
  description = "opencouncil-tasks dev shell and preview deployment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs, nixpkgs-unstable }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems =
        f: nixpkgs.lib.genAttrs systems (system: f system (import nixpkgs { inherit system; }) (import nixpkgs-unstable {
          inherit system;
          config.allowUnfreePredicate = pkg: builtins.elem (nixpkgs-unstable.lib.getName pkg) [
            "ngrok"
          ];
        }));
    in {
      devShells = forAllSystems (_system: pkgs: pkgs-unstable: {
        default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs
            pkgs.nodePackages.npm
            pkgs.minio
            pkgs.minio-client
            pkgs.cachix
            pkgs-unstable.ngrok
          ];

          shellHook = ''
            echo ""
            echo "Inside opencouncil-tasks Nix dev shell"
            echo ""
            echo "  node $(node --version)"
            echo "  npm  $(npm --version)"
            echo ""
            echo "Run 'npm install' then 'npm test' to run tests."
          '';
        };
      });

      # Production build package
      packages = forAllSystems (_system: pkgs: pkgs-unstable: {
        opencouncil-tasks-prod = pkgs.buildNpmPackage {
          pname = "opencouncil-tasks-prod";
          version = "1.0.0";
          src = ./.;

          npmDepsHash = "sha256-P9hdMBD9Rsdl00m1Sp3aawafWUHb1j4y8iWu0jWdGfU=";

          # Handle peer dependency conflicts and skip postinstall scripts
          # (puppeteer downloads Chromium, ffmpeg-static downloads ffmpeg)
          # The preview server will use system-provided binaries instead
          npmFlags = [ "--legacy-peer-deps" "--ignore-scripts" ];

          # Build the TypeScript project
          buildPhase = ''
            npm run build
          '';

          # Install compiled output and dependencies
          installPhase = ''
            runHook preInstall

            mkdir -p $out
            cp -r dist $out/
            cp -r node_modules $out/
            cp package.json $out/

            # Create start script that sets working directory
            cat > $out/start.sh <<'EOF'
#!/usr/bin/env bash
cd "$(dirname "$0")"
exec node dist/server.js
EOF
            chmod +x $out/start.sh

            runHook postInstall
          '';

          # Skip npm test during build
          doCheck = false;

          meta = {
            description = "OpenCouncil Tasks - Media processing pipeline service";
            mainProgram = "start.sh";
          };
        };
      });

      # Preview deployment config for the generic preview module in nix-openclaw.
      # See nix-openclaw/generic-preview.nix for the full interface spec.
      preview = {
        name = "opencouncil-tasks";
        domain = "tasks.opencouncil.gr";
        defaultBasePort = 4000;

        cachix = {
          defaultName = "opencouncil";
          defaultPublicKey = "opencouncil.cachix.org-1:D6DC/9ZvVTQ8OJkdXM86jny5dQWjGofNq9p6XqeCWwI=";
        };

        mkStartScript = pkgs: { port, prNum, prDir, appDir, cfg }: ''
          export PUBLIC_URL="https://pr-$PR_NUM.${cfg.previewDomain}"
          export PR_NUMBER="$PR_NUM"
          export DATA_DIR="$PR_DIR/data"
          mkdir -p "$DATA_DIR"

          # Use system binaries (ffmpeg-static download was skipped in Nix build)
          export FFMPEG_BIN_PATH="${pkgs.ffmpeg}/bin/ffmpeg"
          export YTDLP_BIN_PATH="${pkgs.yt-dlp}/bin/yt-dlp"
          export PATH="${pkgs.ffmpeg}/bin:${pkgs.yt-dlp}/bin:$PATH"

          cd "$APP_DIR"
          exec ${pkgs.nodejs}/bin/node dist/server.js
        '';
      };
    };
}
