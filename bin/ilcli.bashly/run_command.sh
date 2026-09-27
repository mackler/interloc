ensure_running
forwarded_args run
exec docker compose -f "$(ilcli_root)/compose.cc.yaml" exec -it cc claude "${forwarded[@]}"
