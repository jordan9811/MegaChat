// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * MegaChatEscrow — one viewer's deposit for one session, held by rules, not by us.
 *
 * WHAT IT HOLDS. A viewer's session cap, pulled once at join from the allowance
 * they already grant today, and released on a timer. The platform never holds
 * the float: the tokens sit in this contract, the streamer is fixed at deposit,
 * and nothing here can send money anywhere but to that streamer, that viewer,
 * or the fee recipient declared at deposit.
 *
 * THE RULES, WHO MAY INVOKE THEM, AND WHICH WAY MONEY CAN MOVE.
 *
 *   deposit         OPERATOR only. Pulls `amount` of TOKEN from the viewer.
 *                   Records viewer, streamer, rate, deadline, fee. The streamer
 *                   is immutable from here on.
 *   attest          ATTESTER only. Reports consumed seconds and hidden seconds.
 *                   Deterministic: paid = (consumed − hidden) × rate, clamped to
 *                   the cap. An attestation can ONLY reduce what the streamer is
 *                   paid — a second one that would pay the streamer more reverts.
 *                   There is no call that increases the streamer's share.
 *   finalize        ANYONE, once the deadline has passed. Default outcome pays
 *                   the streamer everything not attested away; the rest goes
 *                   back to the viewer. Server silence pays the streamer; it
 *                   never strands money.
 *   streamerRefund  STREAMER only, any time before finalize, any amount up to
 *                   what remains, no conditions. The cheapest resolution here.
 *   flag            ANYONE may relay. Each signature is an EIP-712 flag from an
 *                   address that deposited in the same session; anything else
 *                   is rejected on-chain with zero weight. Enough distinct
 *                   depositors by count AND by deposited value extend the
 *                   session's deadline ONCE, by a bounded amount. A flag never
 *                   moves money.
 *   setEscalation   OWNER only. Tunes the three escalation parameters within
 *                   hard bounds. Cannot touch funds, deadlines already set, or
 *                   fees already declared.
 *
 * WHAT THE PLATFORM CANNOT DO, BY CONSTRUCTION.
 *   - hold or redirect funds: transfers go only to streamer / viewer / fee recipient.
 *   - take more than the fee declared at deposit, which is capped at MAX_FEE_BPS.
 *   - hold funds indefinitely: a deposit's deadline is at most MAX_HOLD out, and
 *     escalation adds at most MAX_EXTENSION, once.
 *   - stop a payout: finalize is permissionless after the deadline.
 *   - forge a flag: signatures are verified here against the session's depositors.
 *   - upgrade, pause, sweep or rescue: there is no such function. Tokens sent to
 *     this address outside deposit() are unrecoverable.
 *
 * WHAT A VIEWER STILL TRUSTS THE PLATFORM FOR. The attestation itself — no
 * contract can see an OBS overlay, so whether hidden time is reported is the
 * platform's honesty. The client code that authorises the deposit. And, since
 * the operator names the streamer at deposit, that the streamer is the room's
 * real payout address. None of that is trustless and this file does not claim
 * it is. See docs/internal/escrow-contract.md.
 *
 * UNITS. Amounts are TOKEN atomic units (uint96). Seconds are uint32. The cap
 * in seconds is deposited / rate; any remainder below one second's rate can
 * never be earned and always returns to the viewer.
 *
 * TIP-20 tokens on Tempo are precompiles with the ERC-20 transfer surface and
 * no receiver hooks, so no transfer in this contract can hand control to a
 * third party mid-call. Checks-effects-interactions and a reentrancy guard are
 * kept anyway.
 */
interface ITIP20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// TIP-1020: the enshrined signature verifier at 0x5165…, which recovers
/// secp256k1 (65 bytes, r||s||v), P256 and WebAuthn signers alike and reverts
/// on anything malformed. Using it instead of raw ecrecover means a viewer on
/// a passkey wallet can flag too, and future Tempo signature schemes verify
/// without redeploying this contract.
interface ISignatureVerifier {
    function recover(bytes32 hash, bytes calldata signature) external view returns (address signer);
}

contract MegaChatEscrow {
    // ── roles and token: fixed at deployment, no setters ─────────────────────
    ITIP20 public immutable TOKEN;
    address public immutable OPERATOR;      // may deposit
    address public immutable ATTESTER;      // may attest (a separate key, never the payout key)
    address public immutable OWNER;         // may tune escalation parameters, nothing else
    address public immutable FEE_RECIPIENT; // receives the declared fee, if any

    // ── hard bounds: constants, not parameters ───────────────────────────────
    ISignatureVerifier public constant SIGNATURE_VERIFIER = ISignatureVerifier(0x5165300000000000000000000000000000000000);

    uint16 public constant MAX_FEE_BPS = 1_000;      // 10%. A declared fee above this is refused.
    uint64 public constant MAX_HOLD = 14 days;       // a deposit's deadline can be at most this far out
    uint64 public constant MAX_EXTENSION = 7 days;   // escalation can add at most this, once
    uint256 private constant BPS = 10_000;
    string public constant VERSION = "1";

    // ── escalation parameters: owner-settable inside the bounds above ────────
    uint32 public minFlaggers = 3;
    uint16 public thresholdBps = 2_500;      // flagged deposits must be ≥ 25% of the session's deposits
    uint64 public extensionSeconds = 48 hours;

    struct Escrow {
        // slot 1
        address viewer;
        uint96 deposited;
        // slot 2
        address streamer;
        uint96 remaining;    // deposited minus streamer refunds so far
        // slot 3
        uint96 rate;         // atomic units per second
        uint64 releaseAt;    // base deadline; the session's extension is added on top
        uint32 consumed;     // seconds, valid when attested
        uint32 hidden;       // seconds, valid when attested
        uint16 feeBps;
        bool attested;
        bool finalized;
        // slot 4
        bytes32 sessionId;
    }

    struct Session {
        uint96 deposited;    // sum of deposits ever made in this session
        uint96 flaggedValue; // sum of the deposits of addresses that flagged
        uint32 flaggers;     // distinct flagging addresses
        uint32 depositors;   // distinct depositing addresses
        uint64 extension;    // seconds added to every deadline in this session, set once
        bool extended;
    }

    mapping(bytes32 => Escrow) private _escrows;
    mapping(bytes32 => Session) private _sessions;
    /// sessionId => address => value deposited in that session (eligibility and flag weight)
    mapping(bytes32 => mapping(address => uint96)) public depositOf;
    mapping(bytes32 => mapping(address => bool)) public hasFlagged;

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant FLAG_TYPEHASH = keccak256("Flag(bytes32 sessionId)");

    uint256 private _entered = 1;

    event Deposited(bytes32 indexed id, bytes32 indexed sessionId, address indexed viewer, address streamer, uint96 amount, uint96 rate, uint64 releaseAt, uint16 feeBps);
    event Attested(bytes32 indexed id, uint32 consumedSeconds, uint32 hiddenSeconds, uint32 requestedConsumed, uint32 requestedHidden);
    event StreamerRefunded(bytes32 indexed id, uint96 amount, uint96 remaining);
    event Finalized(bytes32 indexed id, uint96 toStreamer, uint96 fee, uint96 toViewer, address by);
    event Flagged(bytes32 indexed sessionId, address indexed flagger, uint96 weight);
    event FlagRejected(bytes32 indexed sessionId, address recovered, string reason);
    event Escalated(bytes32 indexed sessionId, uint32 flaggers, uint96 flaggedValue, uint64 extension);
    event EscalationParams(uint32 minFlaggers, uint16 thresholdBps, uint64 extensionSeconds);

    error NotOperator();
    error NotAttester();
    error NotOwner();
    error NotStreamer();
    error ZeroAddress();
    error EscrowExists();
    error NoSuchEscrow();
    error AlreadyFinalized();
    error TooEarly(uint64 releaseAt);
    error BadAmount();
    error BadDeadline();
    error FeeTooHigh();
    error RefundExceedsRemaining();
    error AttestationWouldFavourStreamer();
    error BadParams();
    error TransferFailed();
    error Reentrant();

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrant();
        _entered = 2;
        _;
        _entered = 1;
    }

    constructor(address token, address operator, address attester, address owner, address feeRecipient) {
        if (token == address(0) || operator == address(0) || attester == address(0) || owner == address(0) || feeRecipient == address(0)) revert ZeroAddress();
        TOKEN = ITIP20(token);
        OPERATOR = operator;
        ATTESTER = attester;
        OWNER = owner;
        FEE_RECIPIENT = feeRecipient;
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("MegaChatEscrow"), keccak256("1"), block.chainid, address(this)
        ));
        emit EscalationParams(minFlaggers, thresholdBps, extensionSeconds);
    }

    // ── deposit ──────────────────────────────────────────────────────────────

    /**
     * Pull `amount` of TOKEN from `viewer` (who has approved this contract for
     * at least that much) and hold it for `streamer` until `releaseAt`.
     * `rate` is the per-second price the seat was sold at; the cap in seconds
     * is amount / rate. `feeBps` is the platform's declared cut of what the
     * streamer earns, fixed here forever for this deposit.
     */
    function deposit(
        bytes32 id, address viewer, address streamer, uint96 amount, uint64 releaseAt, uint16 feeBps, uint96 rate, bytes32 sessionId
    ) external nonReentrant {
        if (msg.sender != OPERATOR) revert NotOperator();
        Escrow storage e = _escrows[id];
        if (e.viewer != address(0)) revert EscrowExists();
        if (viewer == address(0) || streamer == address(0) || streamer == address(this) || sessionId == bytes32(0)) revert ZeroAddress();
        if (rate == 0 || amount < rate) revert BadAmount();
        if (releaseAt <= block.timestamp || releaseAt > block.timestamp + MAX_HOLD) revert BadDeadline();
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();

        e.viewer = viewer;
        e.streamer = streamer;
        e.deposited = amount;
        e.remaining = amount;
        e.rate = rate;
        e.releaseAt = releaseAt;
        e.feeBps = feeBps;
        e.sessionId = sessionId;

        Session storage s = _sessions[sessionId];
        if (depositOf[sessionId][viewer] == 0) s.depositors += 1;
        depositOf[sessionId][viewer] += amount;
        s.deposited += amount;

        if (!TOKEN.transferFrom(viewer, address(this), amount)) revert TransferFailed();
        emit Deposited(id, sessionId, viewer, streamer, amount, rate, releaseAt, feeBps);
    }

    // ── attest: the one server signal, and it only ever helps the viewer ─────

    /**
     * Report how many seconds the viewer was charged for and how many of those
     * the guest was hidden. Both are clamped: consumed to the cap, hidden to
     * consumed. What the streamer is paid is (consumed − hidden) × rate. Once
     * attested, a later attestation must not raise that figure.
     */
    function attest(bytes32 id, uint32 consumedSeconds, uint32 hiddenSeconds) external {
        if (msg.sender != ATTESTER) revert NotAttester();
        Escrow storage e = _escrow(id);
        if (e.finalized) revert AlreadyFinalized();
        uint256 cap = uint256(e.deposited) / e.rate;
        uint32 c = consumedSeconds > cap ? uint32(cap) : consumedSeconds;
        uint32 h = hiddenSeconds > c ? c : hiddenSeconds;
        if (e.attested && (uint256(c) - h) > (uint256(e.consumed) - e.hidden)) revert AttestationWouldFavourStreamer();
        e.consumed = c;
        e.hidden = h;
        e.attested = true;
        emit Attested(id, c, h, consumedSeconds, hiddenSeconds);
    }

    // ── finalize: permissionless, after the deadline ─────────────────────────

    function finalize(bytes32 id) external nonReentrant {
        Escrow storage e = _escrow(id);
        if (e.finalized) revert AlreadyFinalized();
        uint64 due = effectiveReleaseAt(id);
        if (block.timestamp < due) revert TooEarly(due);
        (uint96 gross, uint96 fee, uint96 refund) = _outcome(e);
        uint96 toStreamer = gross - fee;
        e.finalized = true;
        e.remaining = 0;
        if (toStreamer > 0 && !TOKEN.transfer(e.streamer, toStreamer)) revert TransferFailed();
        if (fee > 0 && !TOKEN.transfer(FEE_RECIPIENT, fee)) revert TransferFailed();
        if (refund > 0 && !TOKEN.transfer(e.viewer, refund)) revert TransferFailed();
        emit Finalized(id, toStreamer, fee, refund, msg.sender);
    }

    // ── streamerRefund: the streamer gives money back, no questions asked ────

    function streamerRefund(bytes32 id, uint96 amount) external nonReentrant {
        Escrow storage e = _escrow(id);
        if (msg.sender != e.streamer) revert NotStreamer();
        if (e.finalized) revert AlreadyFinalized();
        if (amount == 0 || amount > e.remaining) revert RefundExceedsRemaining();
        e.remaining -= amount;
        bool closed = e.remaining == 0;
        if (closed) e.finalized = true;
        if (!TOKEN.transfer(e.viewer, amount)) revert TransferFailed();
        emit StreamerRefunded(id, amount, e.remaining);
        if (closed) emit Finalized(id, 0, 0, 0, msg.sender);
    }

    // ── flag: relayed, verified, weighted by deposit; extends once ───────────

    /**
     * Each signature is EIP-712 `Flag(bytes32 sessionId)` over this contract's
     * domain, signed by an address that deposited in the escrow's session.
     * Anything else is rejected with no weight. Reaching BOTH thresholds
     * (distinct flaggers ≥ minFlaggers, flagged value ≥ thresholdBps of the
     * session's deposits) extends every deadline in the session by the
     * extension in force at that moment — once, and never again.
     */
    function flag(bytes32 id, bytes[] calldata signatures) external {
        Escrow storage e = _escrow(id);
        bytes32 sessionId = e.sessionId;
        Session storage s = _sessions[sessionId];
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(FLAG_TYPEHASH, sessionId))));
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = _recover(digest, signatures[i]);
            uint96 weight = signer == address(0) ? 0 : depositOf[sessionId][signer];
            if (weight == 0) { emit FlagRejected(sessionId, signer, "no deposit in session"); continue; }
            if (hasFlagged[sessionId][signer]) { emit FlagRejected(sessionId, signer, "already flagged"); continue; }
            hasFlagged[sessionId][signer] = true;
            s.flaggers += 1;
            s.flaggedValue += weight;
            emit Flagged(sessionId, signer, weight);
        }
        if (!s.extended && s.flaggers >= minFlaggers && uint256(s.flaggedValue) * BPS >= uint256(s.deposited) * thresholdBps) {
            s.extended = true;
            s.extension = extensionSeconds;
            emit Escalated(sessionId, s.flaggers, s.flaggedValue, s.extension);
        }
    }

    // ── owner: escalation parameters, bounded ────────────────────────────────

    function setEscalation(uint32 minFlaggers_, uint16 thresholdBps_, uint64 extensionSeconds_) external {
        if (msg.sender != OWNER) revert NotOwner();
        if (minFlaggers_ == 0 || thresholdBps_ == 0 || thresholdBps_ > BPS || extensionSeconds_ > MAX_EXTENSION) revert BadParams();
        minFlaggers = minFlaggers_;
        thresholdBps = thresholdBps_;
        extensionSeconds = extensionSeconds_;
        emit EscalationParams(minFlaggers_, thresholdBps_, extensionSeconds_);
    }

    // ── views ────────────────────────────────────────────────────────────────

    function escrow(bytes32 id) external view returns (Escrow memory) { return _escrows[id]; }
    function session(bytes32 sessionId) external view returns (Session memory) { return _sessions[sessionId]; }

    function effectiveReleaseAt(bytes32 id) public view returns (uint64) {
        Escrow storage e = _escrows[id];
        return e.releaseAt + _sessions[e.sessionId].extension;
    }

    function capSeconds(bytes32 id) external view returns (uint256) {
        Escrow storage e = _escrow(id);
        return uint256(e.deposited) / e.rate;
    }

    /// What finalize would pay right now: (toStreamer, fee, toViewer).
    function outcome(bytes32 id) external view returns (uint96 toStreamer, uint96 fee, uint96 toViewer) {
        Escrow storage e = _escrow(id);
        (uint96 gross, uint96 f, uint96 refund) = _outcome(e);
        return (gross - f, f, refund);
    }

    // ── internals ────────────────────────────────────────────────────────────

    function _escrow(bytes32 id) internal view returns (Escrow storage e) {
        e = _escrows[id];
        if (e.viewer == address(0)) revert NoSuchEscrow();
    }

    function _outcome(Escrow storage e) internal view returns (uint96 gross, uint96 fee, uint96 refund) {
        uint256 cap = uint256(e.deposited) / e.rate;
        uint256 paidSeconds = e.attested ? (uint256(e.consumed) - e.hidden) : cap;
        uint256 g = paidSeconds * e.rate;
        if (g > e.remaining) g = e.remaining;
        gross = uint96(g);
        fee = uint96(g * e.feeBps / BPS);
        refund = uint96(uint256(e.remaining) - g);
    }

    /// Recovery through the TIP-1020 verifier precompile. It reverts on a
    /// malformed or invalid signature; that becomes address(0) here, which
    /// flag() records as a rejected flag with no weight.
    function _recover(bytes32 digest, bytes calldata sig) internal view returns (address) {
        try SIGNATURE_VERIFIER.recover(digest, sig) returns (address signer) {
            return signer;
        } catch {
            return address(0);
        }
    }
}
