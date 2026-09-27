long_usage=yes
case "${args[command]:-}" in
  "") ilcli_usage ;;
  *) "ilcli_${args[command]}_usage" ;;
esac
