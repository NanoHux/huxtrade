"""Push assistant output to Telegram through the existing outbox.

Splits at Telegram's 4096-character limit on line boundaries, so a long reply
arrives as several readable messages instead of being rejected whole.
"""
import subprocess,sys

LIMIT=3800
text=sys.stdin.read().rstrip()
if not text:
    sys.exit(0)

chunks,cur=[],""
for line in text.split("\n"):
    while len(line)>LIMIT:
        if cur: chunks.append(cur); cur=""
        chunks.append(line[:LIMIT]); line=line[LIMIT:]
    if len(cur)+len(line)+1>LIMIT:
        chunks.append(cur); cur=line
    else:
        cur=(cur+"\n"+line) if cur else line
if cur: chunks.append(cur)

for index,chunk in enumerate(chunks):
    body=chunk if len(chunks)==1 else f"({index+1}/{len(chunks)}) {chunk}"
    # $q$ dollar-quoting keeps quotes and newlines intact; the tag itself is
    # stripped from the body so it cannot terminate the literal early.
    subprocess.run(
        ["docker","compose","exec","-T","postgres","psql","-U","huxtrade","-d","huxtrade","-c",
         "INSERT INTO outbox(topic,payload) VALUES('notification.operator_reply',"
         "jsonb_build_object('answer',$q$"+body.replace("$q$","")+"$q$))"],
        check=True,stdout=subprocess.DEVNULL)
print(f"queued {len(chunks)} telegram message(s)")
