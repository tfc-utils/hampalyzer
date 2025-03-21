import { Event } from "./parser.js";
import EventType from './eventType.js';
import { EventSubscriber, EventHandlingPhase, HandlerRequest } from "./eventSubscriberManager.js";
import { RoundState } from "./roundState.js";
import { TeamScore } from "./parserUtils.js";
import { FlagMovement, FlagMovementType, ParsingError, TeamColor, TeamFlagMovements } from "./constants.js";
import Player from "./player.js";

class TeamFlagRoundStats {
    public numberOfCaps: number = 0;
    public numberOfBonusCaps: number = 0;
    public teamFlagHoldBonuses: number = 0;
    public score: number = 0;
    public flagEvents: Event[] = [];
}

class FlagStatus {
    public carrier: Player | null = null;
    public timeFlagWasPickedUpInGameSeconds: number | null = null;
    public timeFlagWasDroppedInGameSeconds: number | null = null;
    public bonusActive: boolean = false;
    public hasBeenTouched: boolean = false;
}

export class FlagMovementTracker extends EventSubscriber {
    // TODO: specify map-specific intervals for maps with lower return times.
    private readonly defaultFlagReturnIntervalInSeconds: number = 65;

    // Tracks the player current carrying the flag of a given TeamColor.
    // For example, a blue player carrying the red flag would be tracked via
    // TeamColor.Red.
    private currentFlagStatusByTeam: Record<TeamColor, FlagStatus>;
    private sawTeamScoresEvent: boolean = false;
    private flagRoundStatsByTeam: Record<TeamColor, TeamFlagRoundStats>;

    private _score: TeamScore = {};
    get score() {
        return this._score;
    }

    private _teamFlagMovements: TeamFlagMovements = {};
    get teamFlagMovements() {
        return this._teamFlagMovements;
    }

    private pointsPerCap = 10;
    private pointsPerBonusCap = this.pointsPerCap;
    private readonly pointsPerTeamFlagHoldBonus = 5; // Assume 5 points for flag hold bonus (ss_nyx_ectfc).

    constructor() {
        super();

        this.currentFlagStatusByTeam = {
            [TeamColor.None]: new FlagStatus(),
            [TeamColor.Blue]: new FlagStatus(),
            [TeamColor.Red]: new FlagStatus(),
            [TeamColor.Green]: new FlagStatus(),
            [TeamColor.Yellow]: new FlagStatus(),
            [TeamColor.Spectator]: new FlagStatus(),
        };

        this.flagRoundStatsByTeam = {
            [TeamColor.None]: new TeamFlagRoundStats(),
            [TeamColor.Blue]: new TeamFlagRoundStats(),
            [TeamColor.Red]: new TeamFlagRoundStats(),
            [TeamColor.Green]: new TeamFlagRoundStats(),
            [TeamColor.Yellow]: new TeamFlagRoundStats(),
            [TeamColor.Spectator]: new TeamFlagRoundStats(),
        };
    }


    phaseStart(phase: EventHandlingPhase, roundState: RoundState): void {
        switch (phase) {
            case EventHandlingPhase.Main:
                break;
            default:
                throw new ParsingError({
                    name: 'LOGIC_FAILURE',
                    message: "Unexpected phase"
                });
        }
    }

    phaseEnd(phase: EventHandlingPhase, roundState: RoundState): void {
        switch (phase) {
            case EventHandlingPhase.Main:
                for (let team in this.currentFlagStatusByTeam) {
                    if (this.currentFlagStatusByTeam[team].carrier !== null) {
                        // The flag was being held when the game ended.
                        this.currentFlagStatusByTeam[team].carrier.flagCarryTimeInSeconds +=
                            roundState.roundEndTimeInGameSeconds - this.currentFlagStatusByTeam[team].timeFlagWasPickedUpInGameSeconds;
                    }
                    this.currentFlagStatusByTeam[team] = new FlagStatus();
                }
                this.computeScoreAndFlagMovements();
                break;
            default:
                throw new ParsingError({
                    name: 'LOGIC_FAILURE',
                    message: "Unexpected phase"
                });
        }
    }

    handleEvent(event: Event, phase: EventHandlingPhase, roundState: RoundState): HandlerRequest {
        switch (phase) {
            case EventHandlingPhase.Main:
                if (event.playerFrom && event.playerFrom.currentStatus.carryingFlag) {
                    event.playerFromWasCarryingFlag = true;
                }
                if (event.playerTo && event.playerTo.currentStatus.carryingFlag) {
                    event.playerToWasCarryingFlag = true;
                }
                switch (event.eventType) {
                    case EventType.TeamFlagHoldBonus:
                        this.flagRoundStatsByTeam[event.data!.team!].teamFlagHoldBonuses++;
                        this.flagRoundStatsByTeam[event.data!.team!].flagEvents.push(event);
                        break;
                    case EventType.TeamScore:
                        {
                            const team = event.data && event.data.team;
                            const score = event.data && event.data.value;
                            if (!team) {
                                throw new ParsingError({
                                    name: 'PARSING_FAILURE',
                                    message: "expected team with a TeamScore event"
                                });
                            }
                            if (!score) {
                                throw new ParsingError({
                                    name: 'PARSING_FAILURE',
                                    message: "expected value with a TeamScore event"
                                });
                            }
                            this.flagRoundStatsByTeam[team].score = Number(score);
                            this.sawTeamScoresEvent = true;
                        }
                        break;
                    case EventType.PlayerPickedUpFlag:
                        {
                            this.flagRoundStatsByTeam[event.playerFrom!.team].flagEvents.push(event);

                            let flagStatusToUpdate = this.currentFlagStatusByTeam[event.data!.team!]!;
                            let player = event.playerFrom!;
                            flagStatusToUpdate.carrier = player;
                            player.currentStatus.carryingFlag = true;
                            player.roundStats.flagCarries++;
                            if (!flagStatusToUpdate.hasBeenTouched) {
                                flagStatusToUpdate.hasBeenTouched = true;
                                player.roundStats.flagInitialTouches++;
                            }
                            flagStatusToUpdate.bonusActive = false;
                            flagStatusToUpdate.timeFlagWasPickedUpInGameSeconds = event.gameTimeAsSeconds!;
                            flagStatusToUpdate.timeFlagWasDroppedInGameSeconds = null;
                        }
                        break;
                    case EventType.PlayerPickedUpBonusFlag:
                        {
                            // don't record this fact; just update flag status
                            let flagStatusToUpdate = this.currentFlagStatusByTeam[event.data!.team!];
                            if (!flagStatusToUpdate.carrier || !flagStatusToUpdate.carrier.matches(event.playerFrom!)) {
                                console.error("Bonus flag pickup seen by a player (" + event.playerFrom!.name + ") which wasn't carrying the flag"
                                    + " (was carried by " + flagStatusToUpdate.carrier!.name + ")");
                            }
                            else {
                                flagStatusToUpdate.bonusActive = true;
                                event.playerFrom!.currentStatus.carryingFlagBonus = true;
                            }
                        }
                        break;
                    case EventType.FlagReturn:
                        if (!event.data) {
                            // TODO: throw here instead and determine if it's possible to see a flag return without a team associated with it.
                            for (let team in this.currentFlagStatusByTeam) {
                                this.currentFlagStatusByTeam[team] = new FlagStatus();
                            }
                            break;
                        }
                        this.currentFlagStatusByTeam[event.data.team!] = new FlagStatus();
                        break;
                    case EventType.PlayerThrewFlag:
                    case EventType.PlayerFraggedPlayer:
                    case EventType.PlayerCommitSuicide:
                    case EventType.PlayerLeftServer:
                        {
                            let flagDropper = event.eventType === EventType.PlayerThrewFlag ? event.playerFrom! : event.playerTo!;
                            flagDropper.currentStatus.carryingFlag = false;
                            flagDropper.currentStatus.carryingFlagBonus = false;
                            if (event.eventType === EventType.PlayerThrewFlag) {
                                flagDropper.roundStats.flagThrows++;
                            }
                            for (let team in this.currentFlagStatusByTeam) {
                                if (flagDropper.isSamePlayer(this.currentFlagStatusByTeam[team].carrier)) {
                                    this.flagRoundStatsByTeam[flagDropper.team].flagEvents.push(event);

                                    flagDropper!.roundStats.flagCarryTimeInSeconds +=
                                        event.gameTimeAsSeconds! - this.currentFlagStatusByTeam[team].timeFlagWasPickedUpInGameSeconds;

                                    this.currentFlagStatusByTeam[team].carrier = null;
                                    this.currentFlagStatusByTeam[team].bonusActive = false;
                                    this.currentFlagStatusByTeam[team].timeFlagWasDroppedInGameSeconds = event.gameTimeAsSeconds;
                                }
                            }
                        }
                        break;
                    case EventType.PlayerCapturedFlag:
                    case EventType.PlayerCapturedBonusFlag:
                        let foundCarrierInFlagStatuses = false;
                        let cappingPlayer = event.playerFrom!;

                        cappingPlayer.currentStatus.carryingFlag = false;
                        cappingPlayer.currentStatus.carryingFlagBonus = false;

                        for (let team in this.currentFlagStatusByTeam) {
                            let currentFlagStatus = this.currentFlagStatusByTeam[team];
                            if (event.playerFrom!.isSamePlayer(currentFlagStatus.carrier)) {
                                if (currentFlagStatus.bonusActive === true || event.eventType === EventType.PlayerCapturedBonusFlag) {
                                    event.eventType = EventType.PlayerCapturedBonusFlag;
                                    this.flagRoundStatsByTeam[cappingPlayer.team].numberOfBonusCaps++;
                                }
                                this.flagRoundStatsByTeam[cappingPlayer.team].numberOfCaps++;
                                this.flagRoundStatsByTeam[cappingPlayer.team].flagEvents.push(event);

                                cappingPlayer.roundStats.flagCarryTimeInSeconds += event.gameTimeAsSeconds! - currentFlagStatus.timeFlagWasPickedUpInGameSeconds;

                                this.currentFlagStatusByTeam[team] = new FlagStatus();

                                if (foundCarrierInFlagStatuses) {
                                    console.error(`Flag cap for player (${cappingPlayer.name}) was while carrying the flag of multiple teams`);
                                }
                                foundCarrierInFlagStatuses = true;
                                break;
                            }
                        }
                        if (!foundCarrierInFlagStatuses) {
                            console.error(`Flag cap seen by a player (${cappingPlayer.name}) which wasn't carrying the flag (line ${event.lineNumber})`);
                        }
                        break;
                    default:
                        for (let team in this.currentFlagStatusByTeam) {
                            if (this.currentFlagStatusByTeam[team].carrier == null && this.currentFlagStatusByTeam[team].timeFlagWasDroppedInGameSeconds !== null) {
                                if ((event.gameTimeAsSeconds! - this.currentFlagStatusByTeam[team].timeFlagWasDroppedInGameSeconds) > this.defaultFlagReturnIntervalInSeconds) {
                                    // Assume flag returned.
                                    this.currentFlagStatusByTeam[team] = new FlagStatus();
                                }
                            }
                        }
                        break;
                }
                break;
            case EventHandlingPhase.PostMain:
                break;
            default:
                throw new ParsingError({
                    name: 'LOGIC_FAILURE',
                    message: "Unexpected phase"
                });
        }
        return HandlerRequest.None;
    }

    private computePointsPerCap() {
        if (this.sawTeamScoresEvent) {
            const blueTeamFlagRoundStats = this.flagRoundStatsByTeam[TeamColor.Blue];

            const firstTeamFlagHoldBonuses = blueTeamFlagRoundStats.teamFlagHoldBonuses;
            const pointsFromFlagHoldBonuses = blueTeamFlagRoundStats.numberOfBonusCaps * this.pointsPerTeamFlagHoldBonus;

            if (blueTeamFlagRoundStats.score > 0 && blueTeamFlagRoundStats.numberOfBonusCaps > 0) {
                // This is a map with bonus caps, e.g. raiden6's coast-to-coast mechanic.
                // To estimate the values for a normal cap and a bonus cap, assume a normal cap value of 10.
                this.pointsPerCap = 10;
                const estimatedBonusPointsTotal = blueTeamFlagRoundStats.score - (this.pointsPerCap * (blueTeamFlagRoundStats.numberOfCaps));
                this.pointsPerBonusCap = this.pointsPerCap + (estimatedBonusPointsTotal / blueTeamFlagRoundStats.numberOfBonusCaps);
                console.log(`Estimate points for a bonus cap is ${this.pointsPerBonusCap} (${blueTeamFlagRoundStats.numberOfCaps} caps and ${blueTeamFlagRoundStats.numberOfBonusCaps} bonus caps observed)`);
            }
            else {
                this.pointsPerCap = blueTeamFlagRoundStats.score ?
                    (blueTeamFlagRoundStats.numberOfCaps > 0 ?
                        ((blueTeamFlagRoundStats.score - pointsFromFlagHoldBonuses) / blueTeamFlagRoundStats.numberOfCaps) : this.pointsPerCap)
                    : this.pointsPerCap;
            }
            if (this.pointsPerCap != 10) {
                console.warn(`Points per cap is ${this.pointsPerCap}`);
            }
        }
    }

    private computeScoreAndFlagMovements() {
        this.computePointsPerCap();
    
        let scores: TeamScore = {};
        let flagMovements: TeamFlagMovements = {};
        const needToComputeTeamScore = !this.sawTeamScoresEvent;

        if (!this.sawTeamScoresEvent) { // maybe the server crashed before finishing the log?
            console.warn("Can't find ending score, manually counting caps...");
        }

        let runningScore: TeamScore = {};
        for (const team in this.flagRoundStatsByTeam) {
            scores[team] = this.flagRoundStatsByTeam[team].score;

            if (this.flagRoundStatsByTeam[team].flagEvents.count === 0) {
                continue;
            }

            if (!flagMovements[team]) {
                const teamFlagStats: FlagMovement[] = [];
                flagMovements[team] = teamFlagStats;
                runningScore[team] = 0;
            }
            if (!runningScore[team]) {
                runningScore[team] = 0;
            }


            const flagEvents = this.flagRoundStatsByTeam[team].flagEvents;
            const teamFlagMovements = flagMovements[team] as FlagMovement[];
            flagEvents.forEach((event: Event) => {
                const player = event.playerFrom;
                switch (event.eventType) {
                    case EventType.TeamFlagHoldBonus:
                        runningScore[team] += this.pointsPerTeamFlagHoldBonus;
                        teamFlagMovements.push({
                            type: FlagMovementType.Captured,
                            carrier: "<Team>",
                            current_score: runningScore[team],
                            game_time_as_seconds: event.gameTimeAsSeconds!,
                        });
                        break;
                    case EventType.PlayerPickedUpFlag:
                        teamFlagMovements.push({
                            type: FlagMovementType.Pickup,
                            carrier: player!.name,
                            current_score: runningScore[team],
                            game_time_as_seconds: event.gameTimeAsSeconds!,
                        });
                        break;
                    case EventType.PlayerPickedUpBonusFlag:
                        return; // do nothing
                    case EventType.FlagReturn:
                        teamFlagMovements.push({
                            type: FlagMovementType.Returned,
                            current_score: runningScore[team],
                            game_time_as_seconds: event.gameTimeAsSeconds!,
                        });
                        break;
                    case EventType.PlayerThrewFlag:
                        teamFlagMovements.push({
                            type: FlagMovementType.Thrown,
                            carrier: player!.name,
                            current_score: runningScore[team],
                            game_time_as_seconds: event.gameTimeAsSeconds!,
                        });
                        break;
                    case EventType.PlayerFraggedPlayer:
                    case EventType.PlayerCommitSuicide:
                        teamFlagMovements.push({
                            type: FlagMovementType.Fragged,
                            fragger: player!.name,
                            carrier: event.playerTo!.name,
                            current_score: runningScore[team],
                            game_time_as_seconds: event.gameTimeAsSeconds!,
                        });
                        break;
                    case EventType.PlayerLeftServer:
                        teamFlagMovements.push({
                            type: FlagMovementType.Dropped,
                            carrier: player!.name,
                            current_score: runningScore[team],
                            game_time_as_seconds: event.gameTimeAsSeconds!,
                        });
                        break;
                    case EventType.PlayerCapturedBonusFlag:
                        runningScore[team] += this.pointsPerBonusCap;
                        teamFlagMovements.push({
                            type: FlagMovementType.Captured,
                            carrier: player!.name,
                            current_score: runningScore[team],
                            game_time_as_seconds: event.gameTimeAsSeconds!,
                        });
                        break;
                    case EventType.PlayerCapturedFlag:
                        runningScore[team] += this.pointsPerCap;
                        teamFlagMovements.push({
                            type: FlagMovementType.Captured,
                            carrier: player!.name,
                            current_score: runningScore[team],
                            game_time_as_seconds: event.gameTimeAsSeconds!,
                        });
                        break;
                    default:
                        return;
                }
            });

            if (needToComputeTeamScore) { // only overwrite the team score if there was no teamScore event
                scores[team] = runningScore[team];
            }
        }
        this._score = scores;
        this._teamFlagMovements = flagMovements;
    }
}
