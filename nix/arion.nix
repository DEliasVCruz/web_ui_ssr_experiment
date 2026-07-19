{ inputs, ... }:
{
  perSystem =
    {
      pkgs,
      imageInfo,
      ...
    }:
    let
      # ── Arion "Option A" (design-note gap 4 / decision) ───────────────────
      # A NIX-BUILT compose file the container runtime (podman/docker compose)
      # consumes — as opposed to Option B (arion driving the daemon itself). The
      # generated YAML is plain text referencing image NAME:TAG strings, so it
      # BUILDS on aarch64-darwin even though the images it names are aarch64-linux
      # (realized + loaded via the linux-builder VM, see nix/images.nix). This is
      # the SOLE compose definition (there is no docker-compose.yml, deleted 1vl):
      # postgres + business-logic + web-ui-ssr, plus the pw-browser CDP service the
      # `nix run .#playwright-up` app manages, plus the ci-e2e app's orchestration
      # env (ports, host.docker.internal, healthchecks).
      #
      # `service.image` is set to an external NAME:TAG, which disables arion's own
      # nix image build for these services (image.nixBuild defaults false when
      # service.image is set) — the images come from nix/images.nix, realized on the
      # builder VM and loaded into podman by `nix run .#build-images` (skopeo
      # nix: → docker-archive → podman load).
      names = imageInfo.names;
      tag = imageInfo.tag;

      composition = inputs.arion.lib.eval {
        inherit pkgs;
        modules = [
          (
            { ... }:
            {
              project.name = "web-ui-ssr-experiment";

              docker-compose.volumes.postgres-data = { };

              services = {
                # ── postgres (upstream postgres:17-alpine) ───────────────────
                postgres.service = {
                  image = "postgres:17-alpine";
                  environment = {
                    POSTGRES_DB = "todos";
                    POSTGRES_USER = "todos";
                    POSTGRES_PASSWORD = "todos";
                  };
                  volumes = [ "postgres-data:/var/lib/postgresql/data" ];
                  healthcheck = {
                    test = [
                      "CMD-SHELL"
                      "pg_isready -U todos -d todos"
                    ];
                    interval = "5s";
                    timeout = "5s";
                    retries = 10;
                  };
                  ports = [ "127.0.0.1:5432:5432" ];
                };

                # ── business-logic-java (nix2container image) ────────────────
                business-logic.service = {
                  image = "${names.business-logic-java}:${tag}";
                  depends_on.postgres.condition = "service_healthy";
                  environment = {
                    DATABASE_URL = "jdbc:postgresql://postgres:5432/todos";
                    DATABASE_USERNAME = "todos";
                    DATABASE_PASSWORD = "todos";
                  };
                  ports = [ "127.0.0.1:3001:3001" ];
                };

                # ── web-ui-ssr (nix2container image) ─────────────────────────
                web-ui-ssr.service = {
                  image = "${names.web-ui-ssr}:${tag}";
                  depends_on = [ "business-logic" ];
                  environment = {
                    # Server → backend over the compose network.
                    BUSINESS_LOGIC_URL = "http://business-logic:3001";
                  };
                  ports = [ "127.0.0.1:3000:3000" ];
                };

                # ── pw-browser (new-headless chromium + socat CDP bridge) ────
                # Mirrors `nix run .#playwright-up`: --shm-size 2g, published :9222,
                # and the run.sh forwarded flags (--user-data-dir + the
                # *.docker.internal secure-origin allowlist that lets Service
                # Workers register over the plain-HTTP host.docker.internal
                # origin). host.docker.internal→host-gateway keeps the CDP client
                # and the SSR origin reachable exactly as under the ci-e2e app.
                pw-browser.service = {
                  image = "${names.pw-browser}:local";
                  command = [
                    "--user-data-dir=/tmp/pw-profile"
                    "--unsafely-treat-insecure-origin-as-secure=*.docker.internal"
                  ];
                  ports = [ "127.0.0.1:9222:9222" ];
                  extra_hosts = [ "host.docker.internal:host-gateway" ];
                  # Equivalent of the playwright-up app's --shm-size=2g: a large /dev/shm keeps
                  # Chromium from crashing under --no-sandbox (arion has no
                  # shm_size option; a sized tmpfs mount is the compose analogue).
                  tmpfs = [ "/dev/shm:size=2g" ];
                };
              };
            }
          )
        ];
      };

      # Arion sets only the INERT `x-arion.project.name`; it emits no top-level
      # compose `name:`, so a consumer's project identity would default to the
      # invoking directory's basename — running `podman compose -f …` from a
      # foreign cwd would mint a DIFFERENT project + a `<cwd>_postgres-data` volume,
      # silently splitting state from the `web-ui-ssr-experiment` stack.
      # Inject the top-level `name:` (Compose spec v2) so identity is pinned in the
      # file itself — every consumer (apps.up AND a bare `podman compose config`
      # from any cwd) resolves the same project/volume names.
      namedCompose = pkgs.runCommand "docker-compose.yaml" { nativeBuildInputs = [ pkgs.jq ]; } ''
        jq '. + { name: "web-ui-ssr-experiment" }' ${composition.config.out.dockerComposeYaml} > "$out"
      '';
    in
    {
      # `nix build .#arion-compose` → the generated docker-compose YAML (Option A
      # artifact) with a pinned top-level `name:`. `nix eval .#packages.<sys>
      # .arion-compose` inspects it. apps.up (nix/apps.nix) brings the stack up.
      packages.arion-compose = namedCompose;
    };
}
