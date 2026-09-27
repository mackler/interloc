ensure_running
forwarded_args review
exec docker compose -f "$(ilcli_root)/compose.cc.yaml" exec -it cc node /opt/interloq/src/main.ts "${forwarded[@]}"
