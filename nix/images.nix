{
  perSystem =
    {
      pkgs,
      config,
      lib,
      system,
      inputs',
      ...
    }:
    let
      # ── Image identity (shared with nix/arion.nix via _module.args) ────────
      # Names/tags the Arion compose references and copyToPodman/copyToRegistry
      # push under. Kept here so the compose can never drift from the images.
      imageInfo = {
        tag = "latest";
        names = {
          web-ui-ssr = "web-ui-ssr-experiment/web-ui-ssr";
          business-logic-java = "web-ui-ssr-experiment/business-logic-java";
          # Namespaced like the other two (1vl) so `podman load` yields a
          # DISTINCTIVE docker.io/web-ui-ssr-experiment/pw-browser reference that
          # does NOT collide with any stale `localhost/web-ui-pw-browser:local`
          # left over from the deleted Dockerfile's `podman build`. Keeps the
          # :local tag (playwright-up reuse check).
          pw-browser = "web-ui-ssr-experiment/pw-browser";
        };
      };

      # nix2container builder specialised to THIS system (flake-parts inputs').
      # Only forced inside the linux packages guard below, so darwin eval never
      # instantiates a Linux skopeo.
      n2c = inputs'.nix2container.packages.nix2container;

      # Java runtime for the business-logic image. NOTE: this is the full HEADLESS
      # JDK 25 (~380 MB closure), NOT a trimmed JRE — nixpkgs ships no
      # `temurin-jre-25` and the Dockerfile's eclipse-temurin:25-jre has no direct
      # nixpkgs analogue. It runs the jar correctly; shrinking it to a jlink'd
      # module set (jdeps → custom runtime) is a deploy-size optimization,
      # kept out of scope here to avoid guessing Helidon's module needs.
      # The realized image is aarch64-linux, so this is the Linux JDK closure.
      jre = pkgs.jdk25_headless;

      # ══ web-ui-ssr — bun runtime + dist, vendor BELOW app ═════════════════
      # De-workspaced (5ae): the service is self-contained — a single per-unit
      # node_modules with the @web-ui-poc/rpc package injected (no root/rpc
      # node_modules, no bun workspace symlink):
      #   /app/services/web-ui-ssr/node_modules            (vendor — lower layer)
      #   /app/services/web-ui-ssr/{package.json,dist}      (app   — top layer)
      # The dist tree (server + client + rsbuild manifest + sw.js) is copied as
      # ONE derivation → ONE atomic layer, so a client/server/sw skew can never
      # ship (bd design intent).
      nodeModules = config.packages.web-ui-ssr-node-modules;

      webUiVendorRoot = pkgs.runCommand "web-ui-ssr-vendor-root" { } ''
        mkdir -p "$out/app/services/web-ui-ssr"
        cp -R ${nodeModules}/node_modules "$out/app/services/web-ui-ssr/node_modules"
        chmod -R u+w "$out/app/services/web-ui-ssr/node_modules"
        # Inject the nix-built @web-ui-poc/rpc over bun's file: copy (mirrors the
        # dev postinstall symlink), so any runtime resolution of @web-ui-poc/rpc
        # finds the generated code.
        rm -rf "$out/app/services/web-ui-ssr/node_modules/@web-ui-poc/rpc"
        mkdir -p "$out/app/services/web-ui-ssr/node_modules/@web-ui-poc"
        cp -R ${config.packages.rpc} "$out/app/services/web-ui-ssr/node_modules/@web-ui-poc/rpc"
      '';

      webUiAppRoot = pkgs.runCommand "web-ui-ssr-app-root" { } ''
        mkdir -p "$out/app/services/web-ui-ssr"
        cp ${../services/web-ui-ssr/package.json} "$out/app/services/web-ui-ssr/package.json"
        cp -R ${config.packages.web-ui-ssr}/dist "$out/app/services/web-ui-ssr/dist"
      '';

      imageWebUiSsr = n2c.buildImage {
        name = imageInfo.names.web-ui-ssr;
        tag = imageInfo.tag;
        # bottom→top: bun (most stable) → vendor node_modules → app code (copyToRoot).
        layers = [
          (n2c.buildLayer { deps = [ pkgs.bun ]; })
          (n2c.buildLayer { copyToRoot = [ webUiVendorRoot ]; })
        ];
        copyToRoot = [ webUiAppRoot ];
        config = {
          WorkingDir = "/app/services/web-ui-ssr";
          Cmd = [
            "${pkgs.bun}/bin/bun"
            "dist/server/index.js"
          ];
          # PUBLIC_BUSINESS_LOGIC_URL is baked into the client bundle at BUILD time
          # (rsbuild); BUSINESS_LOGIC_URL is the runtime server→backend target.
          Env = [
            "PORT=3000"
            "NODE_ENV=production"
          ];
          ExposedPorts = {
            "3000/tcp" = { };
          };
        };
      };

      # ══ business-logic-java — JRE + runnable jar + libs ═══════════════════
      # Mirrors services/business-logic-java/Dockerfile's runtime stage:
      #   /app/business-logic-java.jar + /app/libs (Class-Path manifest → libs/).
      bljAppRoot = pkgs.runCommand "business-logic-java-app-root" { } ''
        mkdir -p "$out/app/libs"
        cp ${config.packages.business-logic-java}/business-logic-java.jar "$out/app/business-logic-java.jar"
        cp -R ${config.packages.business-logic-java}/libs/. "$out/app/libs/"
      '';

      imageBusinessLogicJava = n2c.buildImage {
        name = imageInfo.names.business-logic-java;
        tag = imageInfo.tag;
        layers = [ (n2c.buildLayer { deps = [ jre ]; }) ];
        copyToRoot = [ bljAppRoot ];
        config = {
          WorkingDir = "/app";
          Cmd = [
            "${jre}/bin/java"
            "-jar"
            "business-logic-java.jar"
          ];
          # CONFIG_PROFILES=docker layers application-docker.yaml (compose-network
          # db host); PORT/DATABASE_* env still override (env > profile file).
          Env = [
            "CONFIG_PROFILES=docker"
            "PORT=3001"
          ];
          ExposedPorts = {
            "3001/tcp" = { };
          };
        };
      };

      # ══ pw-browser — digest-pinned zenika base + socat + run.sh ═══════════
      # Faithful mirror of tooling/docker/playwright-browser/Dockerfile: the SAME
      # digest-pinned zenika/alpine-chrome:124 base (new-headless chromium honours
      # --unsafely-treat-insecure-origin-as-secure), overlaid with a musl-static
      # socat and the run.sh supervisor (socat bridges 0.0.0.0:9222 → loopback
      # :9223, kills PID1 on its own death). apk is unavailable in a nix2container
      # overlay, so socat comes from pkgsStatic (musl-linked to run on Alpine).
      #
      # PER-ARCH (1vl): zenika/alpine-chrome:124 is a multi-arch OCI index with
      # BOTH linux/amd64 and linux/arm64 sub-manifests. `pullImage` pins a
      # PER-ARCH MANIFEST digest (not the index), so `imageDigest` AND the NAR
      # `sha256` are selected per-system. The realized target is aarch64-linux →
      # arm64 (podman-machine native — Daniel's ruling). NB: the digest pinned
      # since 1w9 (…88859dd…) is in fact the ARM64 manifest (amd64 is …bbd196…);
      # the arm64 base NAR hash was RE-PROVEN through the linux-builder VM (1vl).
      # x86_64-linux/amd64 is PARKED (eval-only, not realized here): its hash is a
      # placeholder — recapture on an amd64 builder (flip to lib.fakeHash → build
      # → read the mismatch, see nix/README.md).
      pwArch =
        {
          x86_64-linux = "amd64";
          aarch64-linux = "arm64";
          aarch64-darwin = "arm64";
        }
        .${system} or "arm64";

      zenikaBaseByArch = {
        arm64 = {
          imageDigest = "sha256:88859ddda17e1faef0b1a0fd38d9c4761dbe1e9b1fb1aa5a14222e53bc20a5f5";
          sha256 = "sha256-1o9FaPLrKrOWWaaoKkREGcHfHeGh9qLo3Y2DS+efO1I=";
        };
        amd64 = {
          imageDigest = "sha256:bbd19645eae3e55c7e3bbe9a7cc8039549e9a42d4509492e93a709f9af436399";
          sha256 = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        };
      };

      zenikaBase = n2c.pullImage {
        imageName = "zenika/alpine-chrome";
        imageDigest = zenikaBaseByArch.${pwArch}.imageDigest;
        sha256 = zenikaBaseByArch.${pwArch}.sha256;
        arch = pwArch;
      };

      pwBrowserRoot = pkgs.runCommand "pw-browser-root" { } ''
        mkdir -p "$out/usr/local/bin" "$out/usr/bin"
        cp ${../tooling/docker/playwright-browser/run.sh} "$out/usr/local/bin/run.sh"
        chmod +x "$out/usr/local/bin/run.sh"
        cp ${pkgs.pkgsStatic.socat}/bin/socat "$out/usr/bin/socat"
      '';

      imagePwBrowser = n2c.buildImage {
        name = imageInfo.names.pw-browser;
        tag = "local";
        fromImage = zenikaBase;
        arch = pwArch;
        copyToRoot = [ pwBrowserRoot ];
        config = {
          User = "chrome";
          Entrypoint = [ "/usr/local/bin/run.sh" ];
          ExposedPorts = {
            "9222/tcp" = { };
          };
        };
      };
    in
    {
      # Share the image identity with nix/arion.nix (both perSystem, same system).
      _module.args.imageInfo = imageInfo;

      # ── Image packages — LINUX only (1vl). The REALIZED target is
      # aarch64-linux (podman-machine native on this aarch64-darwin host —
      # Daniel's 1vl ruling; the old x86_64/Fly ruling is PARKED but its outputs
      # stay evaluable). Both linux systems EVALUATE from aarch64-darwin (the
      # 2pk.4 repin to plain nixpkgs removed devenv-nixpkgs' `applyPatches` IFD,
      # so `nix flake check --no-build --all-systems` resolves them). They are
      # REALIZED on an aarch64-linux builder — the repo-scoped `nix run
      # .#linux-builder` VM (nix/apps.nix) — and loaded into podman by `nix run
      # .#build-images` (nix2container → podman load). x86_64-linux realization
      # is unchanged (parked) and needs its own x86_64 builder + FOD recapture.
      packages =
        lib.optionalAttrs
          (lib.elem system [
            "x86_64-linux"
            "aarch64-linux"
          ])
          {
            image-web-ui-ssr = imageWebUiSsr;
            image-business-logic-java = imageBusinessLogicJava;
            image-pw-browser = imagePwBrowser;
          };
    };
}
