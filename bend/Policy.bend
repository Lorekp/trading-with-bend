import Base

# Pure research/risk policy shared by strategies, splits and model adapters.
type Role is Data:
  Train{}
  Select{}
  Final{}

type Partition is Data:
  Training{}
  Validation{}
  Holdout{}

def can_read(role: Role, partition: Partition) -> Bool:
  match role partition:
    case Train{} Training{}:
      True{}
    case Train{} Validation{}:
      False{}
    case Train{} Holdout{}:
      False{}
    case Select{} Training{}:
      True{}
    case Select{} Validation{}:
      True{}
    case Select{} Holdout{}:
      False{}
    case Final{} Training{}:
      False{}
    case Final{} Validation{}:
      False{}
    case Final{} Holdout{}:
      True{}

def capped_lots(requested: Nat, capital: Nat, position: Nat) -> Nat:
  Nat.min(requested, Nat.min(capital, position))

def training_allowed(observed: Nat, mature: Nat, +cutoff: Nat) -> Bool:
  Bool.and(Nat.is_lt(observed, cutoff), Nat.is_lt(mature, cutoff))

def ready_chain(labels: Nat, +started: Nat, +completed: Nat, +deployed: Nat, decision: Nat) -> Bool:
  Bool.and(Nat.is_le(labels, started),
    Bool.and(Nat.is_le(started, completed),
      Bool.and(Nat.is_le(completed, deployed), Nat.is_le(deployed, decision))))
