# Ghost ears

The phone half of a wearable ghost badge. Open this page in Chrome on
Android, connect to the badge over Bluetooth, and long-press the badge to
talk to the ghost: the phone listens, asks an LLM through OpenRouter, and
sends the reply back to the badge as a speech bubble. It keeps listening
after each reply, so you can go back and forth, until 8 s of quiet, a tap,
or another long-press. Replies can also be spoken aloud, in an ElevenLabs
voice or the phone's own.

Your keys are typed into the page's Settings and kept in that phone's
browser storage. The OpenRouter key is sent only to openrouter.ai, and the
optional ElevenLabs key only to api.elevenlabs.io.

Published from `tools/ghost-phone/` in the badge project. Edit it there.
