"""Push assistant output to Telegram through the existing outbox.

Splits at Telegram's 4096-character limit on line boundaries, so a long reply
arrives as several readable messages instead of being rejected whole.
"""
import subprocess,sys

LIMIT=3800
# Argument or stdin. Reading stdin only meant `tg-say.sh "..."` exited 0 having
# sent nothing — twice. An empty message is now a failure, because the whole
# point of this script is that its silence must mean the message went out.
# --reply <id> also closes out a pending /cc question. It is explicit rather
# than automatic: auto-marking "the oldest unanswered" on every push would
# silently bury a real question whenever this script is used for an unrelated
# update, and a question dropped without an answer is worse than a monitor
# that fires twice.
args=sys.argv[1:]
reply_to=None
if "--reply" in args:
    i=args.index("--reply")
    try: reply_to=int(args[i+1])
    except (IndexError,ValueError): sys.exit("tg-say: --reply needs a numeric operator_messages id")
    del args[i:i+2]

text=(" ".join(args) if args else sys.stdin.read()).rstrip()
if not text:
    sys.exit("tg-say: refusing to send an empty message")

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
if reply_to is not None:
    subprocess.run(
        ["docker","compose","exec","-T","postgres","psql","-U","huxtrade","-d","huxtrade","-c",
         f"UPDATE operator_messages SET answered_at=now(), answer=$q${text.replace('$q$','')}$q$ WHERE id={reply_to} AND answered_at IS NULL"],
        check=True,stdout=subprocess.DEVNULL)
    print(f"marked operator_messages #{reply_to} answered")
print(f"queued {len(chunks)} telegram message(s)")
