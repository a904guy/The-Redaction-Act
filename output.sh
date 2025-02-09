for file in "$@"; do
  echo "$file"
  cat "$file"
done