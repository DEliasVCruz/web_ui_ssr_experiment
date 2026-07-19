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
          # pw-browser keeps the devenv task's :local tag (playwright:up reuse check).
          pw-browser = "web-ui-pw-browser";
        };
      };

      # nix2container builder specialised to THIS system (flake-parts inputs').
      # Only forced inside the x86_64-linux guard below, so darwin eval never
      # instantiates a Linux skopeo.
      n2c = inputs'.nix2container.packages.nix2container;

      # Java runtime for the business-logic image. NOTE: this is the full HEADLESS
      # JDK 25 (~380 MB closure), NOT a trimmed JRE — nixpkgs ships no
      # `temurin-jre-25` and the Dockerfile's eclipse-temurin:25-jre has no direct
      # nixpkgs analogue. It runs the jar correctly; shrinking it to a jlink'd
      # module set (jdeps → custom runtime) is a deploy-size optimization deferred
      # to 2pk.4, kept out of scope here to avoid guessing Helidon's module needs.
      # The image is x86_64-linux, so this is the Linux JDK closure.
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
      zenikaBase = n2c.pullImage {
        imageName = "zenika/alpine-chrome";
        imageDigest = "sha256:88859ddda17e1faef0b1a0fd38d9c4761dbe1e9b1fb1aa5a14222e53bc20a5f5";
        # NAR hash of the amd64 skopeo `dir://` output — pinned via a darwin
        # `skopeo copy --override-arch amd64` + `nix hash path`, so the base is
        # reproducible on the Linux realization host with no follow-up step.
        sha256 = "sha256-1o9FaPLrKrOWWaaoKkREGcHfHeGh9qLo3Y2DS+efO1I=";
        arch = "amd64";
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
        arch = "amd64";
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

      # ── Image packages — x86_64-linux ONLY (Fly.io deploy arch; Daniel's
      # ruling). As of 2pk.4 they DO evaluate from aarch64-darwin: repinning off
      # devenv-nixpkgs to plain nixpkgs removed its per-system `applyPatches` IFD,
      # so instantiating `legacyPackages.x86_64-linux` no longer needs a Linux
      # builder just to evaluate (`nix flake check --all-systems` passes from
      # darwin). They still can NOT be REALIZED on darwin — the Linux closure needs
      # an x86_64-linux builder. 2pk.4+ builds + pushes them on Linux CI agents via
      # nix2container copyToRegistry/copyToPodman. The image plumbing was also
      # smoke-validated by building aarch64-darwin variants (README).
      packages = lib.optionalAttrs (system == "x86_64-linux") {
        image-web-ui-ssr = imageWebUiSsr;
        image-business-logic-java = imageBusinessLogicJava;
        image-pw-browser = imagePwBrowser;
      };
    };
}
