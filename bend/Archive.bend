import Base

# SHA-256 is supplied as eight 32-bit words by the host crypto adapter.
# Require exactly eight matching words: truncated digests never pass.
def digest_equal(expected: List<&2, Nat>, actual: List<&2, Nat>, +remaining: Nat) -> Bool:
  match expected actual:
    case Nil{} Nil{}:
      Nat.is_eq(remaining, 0n)
    case Con{e, es} Con{a, as}:
      Bool.and(Nat.is_gt(remaining, 0n),
        Bool.and(Nat.is_eq(e, a), digest_equal(es, as, Nat.sub(remaining, 1n))))
    case Nil{} Con{a, as}:
      False{}
    case Con{e, es} Nil{}:
      False{}

def accept(expected: List<&2, Nat>, actual: List<&2, Nat>, +expected_bytes: Nat, actual_bytes: Nat) -> Bool:
  Bool.and(Nat.is_gt(expected_bytes, 0n),
    Bool.and(Nat.is_eq(expected_bytes, actual_bytes), digest_equal(expected, actual, 8n)))
