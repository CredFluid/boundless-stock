# Program keys

`swap_request-keypair.json` fixes the program id so it is stable across machines and matches
`declare_id!` in the program source. Anchor projects conventionally commit this.

**These are throwaway localnet/devnet keys. Never deploy a mainnet program with a key from a
git repository.** A real deployment generates its own keypair, keeps it out of version control,
and sets a separate upgrade authority — the program keypair is only needed for the initial
deploy, while the upgrade authority is what actually controls the program afterwards.
