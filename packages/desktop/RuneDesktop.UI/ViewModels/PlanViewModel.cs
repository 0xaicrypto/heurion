// SPDX-License-Identifier: Apache-2.0
//
// PlanViewModel drives the Plan & Billing view in the desktop.
// Surface area:
//
//   * Show the CURRENT subscription (tier, state, trial countdown, next-bill date).
//   * Offer 3 upgrade options (Pro / Pro Plus / Radiology) × 2 cadences (mo / yr).
//   * Provide a "Manage subscription" button that opens the Stripe Customer
//     Portal in the system browser (lets users change card, cancel, see invoices).
//
// All HTTP calls funnel through ApiClient; Stripe URLs come back as plain
// strings that we hand to System.Diagnostics.Process to open in the user's
// default browser.

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RuneDesktop.Core.Services;

namespace RuneDesktop.UI.ViewModels;

public partial class PlanViewModel : ObservableObject
{
    private readonly ApiClient _api;

    // ── Current-state surface ──────────────────────────────────────

    /// <summary>User-facing label for the current tier (e.g. "Pro",
    /// "Radiology Pro"). Falls back to "Free Beta" when null.</summary>
    [ObservableProperty] private string _currentTierLabel = "Free Beta";

    /// <summary>"Trialing", "Active", "Past due", etc. — friendly version
    /// of subscription_state. Empty string = no subscription.</summary>
    [ObservableProperty] private string _stateLabel = "";

    /// <summary>"in 11 days", "in 3 hours", "expired", "—".</summary>
    [ObservableProperty] private string _trialCountdown = "";

    /// <summary>"Nov 28, 2026", "—".</summary>
    [ObservableProperty] private string _renewsOnLabel = "—";

    /// <summary>True when user already has a Stripe customer — show
    /// "Manage subscription" CTA. False = show "Upgrade" CTAs only.</summary>
    [ObservableProperty] private bool _canManage;

    /// <summary>Shown when the server reports billing isn't configured
    /// (STRIPE_SECRET_KEY missing). Plan tab still renders but with
    /// "Contact support to upgrade" instead of buttons.</summary>
    [ObservableProperty] private bool _billingUnavailable;

    /// <summary>True while a request is in-flight. The view disables
    /// buttons + shows a small spinner.</summary>
    [ObservableProperty] private bool _isBusy;

    /// <summary>Error message — set when the last call failed. Empty
    /// when fine.</summary>
    [ObservableProperty] private string _errorMessage = "";

    public PlanViewModel(ApiClient api)
    {
        _api = api;
    }

    /// <summary>Refresh the subscription snapshot from the server. Call
    /// on view activation; the view also auto-refreshes when returning
    /// from a successful checkout (window focus → reload).</summary>
    [RelayCommand]
    public async Task RefreshAsync()
    {
        IsBusy = true;
        ErrorMessage = "";
        try
        {
            var sub = await _api.GetSubscriptionAsync();
            if (sub is null)
            {
                BillingUnavailable = true;
                CurrentTierLabel = "Free Beta";
                StateLabel = "Billing not configured on this server.";
                CanManage = false;
                return;
            }

            BillingUnavailable = false;
            CurrentTierLabel = TierToLabel(sub.Tier);
            StateLabel = StateToLabel(sub.State);
            TrialCountdown = ComputeTrialCountdown(sub.TrialEndsAt);
            RenewsOnLabel = FormatDate(sub.RenewsAt);
            CanManage = sub.ManageUrlAvailable;
        }
        catch (InvalidOperationException ex)
            when (ex.Message.Contains("authenticat", StringComparison.OrdinalIgnoreCase))
        {
            // Swallow the "not authenticated" error — happens when
            // PlanView refreshes before the user has finished login
            // (sibling of ChatView, attaches at app startup). UI just
            // sits on its initial "Free Beta" defaults; the next
            // refresh after login lands real data.
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't load plan: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    // ── Upgrade flow ───────────────────────────────────────────────

    /// <summary>The view binds 6 buttons (3 tiers × 2 cadences) to this
    /// command; the parameter is "tier:cadence" string the button
    /// passes through.</summary>
    [RelayCommand]
    private async Task UpgradeAsync(string? param)
    {
        if (string.IsNullOrEmpty(param)) return;
        var parts = param.Split(':');
        if (parts.Length != 2) return;
        var tier = parts[0];
        var cadence = parts[1];

        IsBusy = true;
        ErrorMessage = "";
        try
        {
            var url = await _api.CreateCheckoutUrlAsync(tier, cadence);
            if (string.IsNullOrEmpty(url))
            {
                ErrorMessage = $"Upgrade not available: tier '{tier}' isn't configured.";
                return;
            }
            OpenInBrowser(url);
            // The user will complete checkout in the browser. We rely
            // on Stripe's webhook to update the server side; the next
            // RefreshAsync (user comes back to the window or clicks
            // refresh) picks up the new state.
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Checkout failed: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand]
    private async Task ManageSubscriptionAsync()
    {
        IsBusy = true;
        ErrorMessage = "";
        try
        {
            var url = await _api.CreatePortalUrlAsync();
            if (string.IsNullOrEmpty(url))
            {
                ErrorMessage = "Subscription management isn't available right now.";
                return;
            }
            OpenInBrowser(url);
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't open subscription page: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    // ── Helpers ────────────────────────────────────────────────────

    /// <summary>Cross-platform "open URL in default browser".
    /// On macOS we shell to /usr/bin/open which is more reliable than
    /// the ShellExecute fallback (which sometimes opens a file picker
    /// when given an http:// URL).</summary>
    private static void OpenInBrowser(string url)
    {
        if (string.IsNullOrEmpty(url)) return;
        try
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
            {
                Process.Start("open", url);
            }
            else if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
            }
            else
            {
                Process.Start("xdg-open", url);
            }
        }
        catch
        {
            // Last-ditch: just don't crash. The user can right-click
            // the error banner to copy the URL.
        }
    }

    private static string TierToLabel(string tier) => tier switch
    {
        "beta"          => "Free Beta",
        "trial"         => "Trial",
        "pro"           => "Pro",
        "pro_plus"      => "Pro Plus",
        "radiology_pro" => "Radiology Pro",
        "radiology"     => "Radiology Pro",   // server canonical name
        "team_seat"     => "Team",
        "enterprise"    => "Enterprise",
        _               => string.IsNullOrEmpty(tier) ? "Free Beta" : tier,
    };

    private static string StateToLabel(string? state) => state switch
    {
        null or ""           => "No active subscription",
        "trialing"           => "Trialing — no charge yet",
        "active"             => "Active",
        "past_due"           => "Payment failed — please update your card",
        "canceled"           => "Cancelled — access until renewal date",
        "unpaid"             => "Unpaid — access suspended",
        "incomplete"         => "Setup incomplete",
        "incomplete_expired" => "Setup expired — please try again",
        "paused"             => "Paused",
        _                    => state,
    };

    /// <summary>"in 11 days" / "in 3 hours" / "ended N days ago" / "—".
    /// trial_ends_at is an ISO-8601 timestamp from the server.</summary>
    private static string ComputeTrialCountdown(string? trialEndsAtIso)
    {
        if (string.IsNullOrEmpty(trialEndsAtIso)) return "—";
        if (!DateTime.TryParse(trialEndsAtIso, out var end)) return "—";
        var delta = end.ToUniversalTime() - DateTime.UtcNow;
        if (delta.TotalSeconds < 0)
        {
            var days = (int)(-delta.TotalDays);
            return days <= 0 ? "ended today" : $"ended {days} day(s) ago";
        }
        if (delta.TotalDays >= 1) return $"in {(int)delta.TotalDays} day(s)";
        if (delta.TotalHours >= 1) return $"in {(int)delta.TotalHours} hour(s)";
        return "in <1 hour";
    }

    private static string FormatDate(string? iso)
    {
        if (string.IsNullOrEmpty(iso)) return "—";
        return DateTime.TryParse(iso, out var d)
            ? d.ToLocalTime().ToString("MMM dd, yyyy")
            : iso;
    }
}
