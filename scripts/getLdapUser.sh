#!/bin/sh
echo $LDAPBINDPW
ldapsearch -x -o ldif-wrap=no -D -w "$LDAPBINDPW" '(uid='"$1"')' "sshPublicKey" | sed -n 's/^[ \t]*sshPublicKey::[ \t]*\(.*\)/\1/p'